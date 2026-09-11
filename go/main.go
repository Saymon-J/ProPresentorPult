// Пропрезентор Пульт — мост на Go (порт server.js).
// Раздаёт вшитый веб-пульт (go:embed public) и проксирует /pp/* в REST API
// ProPresenter с автопоиском порта (50001, 1025).
//
// Флаги:
//   -port 8080        порт пульта
//   -pp 127.0.0.1     адрес машины с ProPresenter
//   -pp-port 50001,1025  кандидаты портов API через запятую
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed public
var embedded embed.FS

var (
	port    = flag.Int("port", 8080, "порт пульта")
	ppHost  = flag.String("pp", "127.0.0.1", "адрес машины с ProPresenter")
	ppPorts = flag.String("pp-port", "50001,1025", "кандидаты портов API ProPresenter, через запятую")
)

var (
	mu         sync.Mutex
	currentPP  string // выбранный порт API
	httpClient = &http.Client{Timeout: 15 * time.Second}
)

var mimeTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json",
	".webmanifest": "application/manifest+json",
	".png":         "image/png",
	".svg":         "image/svg+xml",
}

func candidates() []string {
	var out []string
	for _, p := range strings.Split(*ppPorts, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// alive дёргает GET /version и смотрит поле api_version.
func alive(p string) bool {
	resp, err := httpClient.Get(fmt.Sprintf("http://%s:%s/version", *ppHost, p))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var v struct {
		APIVersion string `json:"api_version"`
	}
	return resp.StatusCode == 200 && json.NewDecoder(resp.Body).Decode(&v) == nil && v.APIVersion != ""
}

// detect ищет живой порт; вызывается на старте и повторно при обрыве связи,
// поэтому мост можно запускать до ProPresenter.
func detect() bool {
	for _, p := range candidates() {
		if alive(p) {
			mu.Lock()
			changed := currentPP != p
			currentPP = p
			mu.Unlock()
			if changed {
				log.Printf("ProPresenter найден: http://%s:%s", *ppHost, p)
			}
			return true
		}
	}
	return false
}

func proxy(w http.ResponseWriter, r *http.Request) {
	target := strings.TrimPrefix(r.URL.Path, "/pp") + r.URL.RawQuery
	if r.URL.RawQuery != "" {
		target = strings.TrimPrefix(r.URL.Path, "/pp") + "?" + r.URL.RawQuery
	}

	var body []byte
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		body, _ = io.ReadAll(r.Body)
	}

	do := func(ppPort string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(r.Context(), r.Method,
			fmt.Sprintf("http://%s:%s%s", *ppHost, ppPort, target), nil)
		if err != nil {
			return nil, err
		}
		for k, vv := range r.Header {
			if strings.EqualFold(k, "Accept-Encoding") { // ответ нужен несжатым
				continue
			}
			for _, v := range vv {
				req.Header.Add(k, v)
			}
		}
		req.Host = *ppHost + ":" + ppPort
		if body != nil {
			req.ContentLength = int64(len(body))
			req.Body = io.NopCloser(strings.NewReader(string(body)))
		}
		return httpClient.Do(req)
	}

	mu.Lock()
	pp := currentPP
	mu.Unlock()
	resp, err := do(pp)
	if err != nil { // могли запустить ProPresenter уже после старта моста
		if !detect() {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprintf(w, `{"error":"ProPresenter недоступен на %s (порты %s). `+
				`Включи API: ProPresenter → Настройки → Сеть → Network."}`, *ppHost, *ppPorts)
			return
		}
		mu.Lock()
		pp = currentPP
		mu.Unlock()
		resp, err = do(pp)
		if err != nil {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprintf(w, `{"error":%q}`, err.Error())
			return
		}
	}
	defer resp.Body.Close()

	for k, vv := range resp.Header {
		if strings.EqualFold(k, "Transfer-Encoding") || strings.EqualFold(k, "Connection") {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func serveStatic(w http.ResponseWriter, r *http.Request) {
	p := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if p == "." || p == "/" {
		p = "index.html"
	}
	data, err := fs.ReadFile(embedded, "public/"+p)
	if err != nil {
		http.Error(w, "Не найдено", http.StatusNotFound)
		return
	}
	ct := mimeTypes[path.Ext(p)]
	if ct == "" {
		ct = "application/octet-stream"
	}
	// no-cache: пульт маленький, зато обновления UI доходят сразу
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}

func lanAddresses(port int) []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, i := range ifaces {
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && !ipn.IP.IsLoopback() {
				out = append(out, fmt.Sprintf("http://%s:%d", ipn.IP, port))
			}
		}
	}
	return out
}

func main() {
	flag.Parse()
	log.SetFlags(0)

	mu.Lock()
	currentPP = candidates()[0]
	mu.Unlock()

	http.HandleFunc("/pp/", proxy)
	http.HandleFunc("/", serveStatic)

	addr := ":" + strconv.Itoa(*port)
	log.Printf("Пульт открыт:      http://localhost:%d", *port)
	for _, a := range lanAddresses(*port) {
		log.Printf("С телефона/планшета: %s", a)
	}
	if detect() {
		go func() { // держим руку на пульсе: раз в 10 с перепроверяем
			for {
				time.Sleep(10 * time.Second)
				if !detect() {
					log.Println("ProPresenter пропал — продолжаю попытки при запросах")
				}
			}
		}()
	} else {
		log.Printf("ProPresenter не найден (порты %s) — продолжу попытки при запросах", *ppPorts)
	}
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Printf("Не удалось запуститься на %s: %v", addr, err)
		log.Println("Чаще всего порт занят другим запущенным пультом (Node-версия или второй экземпляр).")
		log.Println("Запусти на другом порту, например: pult -port 8081")
		// при двойном клике окно консоли закрывается мгновенно — даём прочитать ошибку
		if st, err := os.Stdin.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
			log.Println("(Нажми Enter, чтобы закрыть…)")
			bufio.NewReader(os.Stdin).ReadString('\n')
		}
		os.Exit(1)
	}
}

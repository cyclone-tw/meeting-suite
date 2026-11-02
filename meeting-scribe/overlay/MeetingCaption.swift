// 會議字幕：meeting-scribe 的桌面透明字幕（#32）
// 無邊框、背景透明的面板浮在所有視窗最上層（含全螢幕影片），從主機的 /api/caption/events 收字幕。
// 網頁按「桌面字幕」會用 meetingcaption://connect?server=…&channel=… 叫起本程式並帶入連線資訊。
// 只顯示字幕，不錄音、不存檔；設定（位置、底色、字級）記在本機 UserDefaults。
import AppKit

let defaults = UserDefaults.standard

// 只接受 tailnet（*.ts.net）的 https 或本機測試伺服器，避免任意網頁把小程式導去別的主機
func allowedServer(_ raw: String) -> URL? {
    guard let url = URL(string: raw), let host = url.host?.lowercased(), url.path.isEmpty || url.path == "/" else { return nil }
    if url.scheme == "https" && host.hasSuffix(".ts.net") { return url }
    if url.scheme == "http" && (host == "localhost" || host == "127.0.0.1") { return url }
    return nil
}

func validChannel(_ s: String) -> Bool {
    s.count == 32 && s.allSatisfy { "0123456789abcdef".contains($0) }
}

// ---- 字幕串流：SSE，斷線 3 秒後自動重連 ----
final class CaptionStream: NSObject, URLSessionDataDelegate {
    var onState: (([String: Any]) -> Void)?
    var onStatus: ((String) -> Void)?
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var url: URL?

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 60          // 伺服器每 15 秒送 keepalive
        cfg.timeoutIntervalForResource = 7 * 24 * 3600
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }

    func connect(_ url: URL) {
        self.url = url
        task?.cancel()
        buffer = Data()
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        task = session.dataTask(with: req)
        task?.resume()
        onStatus?("連線中…")
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        onStatus?(code == 200 ? "已連線" : "連線失敗（\(code)）")
        completionHandler(code == 200 ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard dataTask === task else { return }
        buffer.append(data)
        let sep = Data("\n\n".utf8)
        while let r = buffer.range(of: sep) {
            let chunk = buffer.subdata(in: buffer.startIndex..<r.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<r.upperBound)
            guard let text = String(data: chunk, encoding: .utf8) else { continue }
            let payload = text.split(separator: "\n")
                .filter { $0.hasPrefix("data:") }
                .map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }
                .joined(separator: "\n")
            if payload.isEmpty { continue }   // keepalive
            if let obj = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any] {
                onState?(obj)
            }
        }
    }

    func urlSession(_ session: URLSession, task finished: URLSessionTask, didCompleteWithError error: Error?) {
        guard finished === task else { return }
        onStatus?("未連線，3 秒後重試")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self = self, self.task === finished, let url = self.url else { return }
            self.connect(url)
        }
    }
}

// ---- 字幕面板 ----
final class CaptionPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class CaptionView: NSView {
    let label = NSTextField(labelWithString: "")
    var bgAlpha: CGFloat = 0.35 { didSet { needsDisplay = true } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true   // 字太多時從上面裁掉，最新的字留在底部
        label.maximumNumberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        label.preferredMaxLayoutWidth = max(10, bounds.width - 28)
        super.layout()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard bgAlpha > 0 else { return }
        NSColor.black.withAlphaComponent(bgAlpha).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10).fill()
    }

    override var mouseDownCanMoveWindow: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let alphas: [(String, CGFloat)] = [("完全透明", 0), ("淡", 0.25), ("中", 0.45), ("深", 0.7)]
    let sizes: [(String, CGFloat)] = [("小", 22), ("中", 30), ("大", 40), ("特大", 52)]

    var panel: CaptionPanel!
    var view: CaptionView!
    var statusItem: NSStatusItem!
    let stream = CaptionStream()
    var status = "尚未連線：請在 meeting-scribe 網頁按「桌面字幕」"
    var lastState: [String: Any]?
    // 只在錄音中顯示；剛啟動或剛連上先亮幾秒，停止錄音後再留幾秒才收起
    var showUntil = Date().addingTimeInterval(5)
    var graceUntil = Date.distantPast
    var alwaysShow: Bool { defaults.bool(forKey: "alwaysShow") }

    var bgAlpha: CGFloat {
        get { defaults.object(forKey: "bgAlpha") as? CGFloat ?? 0.25 }
        set { defaults.set(newValue, forKey: "bgAlpha"); view.bgAlpha = newValue }
    }
    var fontSize: CGFloat {
        get { defaults.object(forKey: "fontSize") as? CGFloat ?? 30 }
        set { defaults.set(newValue, forKey: "fontSize"); fitHeight(); render() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let width = min(900, screen.width * 0.6)
        let rect = NSRect(x: screen.midX - width / 2, y: screen.minY + 80, width: width, height: 100)
        panel = CaptionPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel, .resizable],
                             backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.minSize = NSSize(width: 240, height: 40)
        view = CaptionView(frame: NSRect(origin: .zero, size: rect.size))
        view.autoresizingMask = [.width, .height]
        panel.contentView = view
        panel.setFrameAutosaveName("MeetingCaptionPanel")
        view.bgAlpha = bgAlpha
        panel.ignoresMouseEvents = defaults.bool(forKey: "clickThrough")
        fitHeight()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "字"

        stream.onStatus = { [weak self] s in self?.status = s; self?.rebuildMenu(); self?.render() }
        stream.onState = { [weak self] st in self?.lastState = st; self?.render() }
        if let server = defaults.string(forKey: "server"), let channel = defaults.string(forKey: "channel") {
            connect(server: server, channel: channel)
        }
        rebuildMenu()
        render()
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateVisibility() }
    }

    func updateVisibility() {
        guard let panel = panel else { return }
        let now = Date()
        if (lastState?["rec"] as? Bool) ?? false { graceUntil = now.addingTimeInterval(4) }
        let visible = alwaysShow || now < graceUntil || now < showUntil
        if visible && !panel.isVisible { panel.orderFrontRegardless() }
        if !visible && panel.isVisible { panel.orderOut(nil) }
    }

    // 網頁叫起本程式時走這裡；程式還沒啟動的話，AppKit 會等 didFinishLaunching 之後才交過來
    // （自己掛 kAEGetURL 處理器在冷啟動時會漏掉第一個網址，2026-10-20 實測）
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  comps.scheme == "meetingcaption", comps.host == "connect" else { continue }
            let q = Dictionary((comps.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
            guard let server = q["server"], let channel = q["channel"] else { continue }
            connect(server: server, channel: channel)
            showUntil = Date().addingTimeInterval(5)
            updateVisibility()
        }
    }

    func connect(server: String, channel: String) {
        guard let base = allowedServer(server), validChannel(channel),
              var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            status = "連線資訊不合法，已忽略"
            rebuildMenu()
            return
        }
        comps.path = "/api/caption/events"
        comps.queryItems = [URLQueryItem(name: "channel", value: channel)]
        guard let url = comps.url else { return }
        defaults.set(server, forKey: "server")
        defaults.set(channel, forKey: "channel")
        lastState = nil
        stream.connect(url)
    }

    // 高度跟著字級：約兩行字
    func fitHeight() {
        guard let panel = panel else { return }
        var f = panel.frame
        let h = ceil(fontSize * 1.35 * 2 + 18)
        f.origin.y += f.height - h
        f.size.height = h
        panel.setFrame(f, display: true)
    }

    func render() {
        guard let view = view else { return }
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        para.lineBreakMode = .byWordWrapping
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.9)
        shadow.shadowBlurRadius = 4
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        func attrs(_ color: NSColor, _ size: CGFloat) -> [NSAttributedString.Key: Any] {
            [.font: NSFont.systemFont(ofSize: size, weight: .medium), .foregroundColor: color, .paragraphStyle: para, .shadow: shadow]
        }
        let out = NSMutableAttributedString()
        let parts = (lastState?["parts"] as? [[String: Any]]) ?? []
        let rec = (lastState?["rec"] as? Bool) ?? false
        if parts.isEmpty {
            let hint = lastState == nil && status != "已連線" ? status : (rec ? "聆聽中…" : "已連上，開始錄音時會出現字幕")
            out.append(NSAttributedString(string: hint, attributes: attrs(NSColor.white.withAlphaComponent(0.55), max(13, fontSize * 0.5))))
        } else {
            for p in parts {
                let final = (p["f"] as? Bool) ?? true
                out.append(NSAttributedString(string: (p["t"] as? String) ?? "",
                                              attributes: attrs(final ? .white : NSColor(white: 0.75, alpha: 1), fontSize)))
            }
        }
        // 收過字幕之後斷線，在底下標示，避免把舊字幕當成現在的
        if lastState != nil && status != "已連線" {
            out.append(NSAttributedString(string: "\n（\(status)）", attributes: attrs(NSColor.systemOrange, max(13, fontSize * 0.45))))
        }
        view.label.attributedStringValue = out
        view.needsLayout = true
        updateVisibility()
    }

    // ---- 選單列 ----
    func rebuildMenu() {
        let menu = NSMenu()
        let st = NSMenuItem(title: status, action: nil, keyEquivalent: "")
        st.isEnabled = false
        menu.addItem(st)
        menu.addItem(.separator())
        menu.addItem(submenu("底色", alphas.map { ($0.0, $0.1, abs($0.1 - bgAlpha) < 0.01) }, #selector(pickAlpha(_:))))
        menu.addItem(submenu("字級", sizes.map { ($0.0, $0.1, abs($0.1 - fontSize) < 0.5) }, #selector(pickSize(_:))))
        let ct = NSMenuItem(title: "點擊穿透（滑鼠點到下面的視窗；要拖曳先關掉）", action: #selector(toggleClickThrough), keyEquivalent: "")
        ct.target = self
        ct.state = panel.ignoresMouseEvents ? .on : .off
        menu.addItem(ct)
        let vis = NSMenuItem(title: "沒在錄音時也顯示", action: #selector(toggleAlwaysShow), keyEquivalent: "")
        vis.target = self
        vis.state = alwaysShow ? .on : .off
        menu.addItem(vis)
        let reset = NSMenuItem(title: "字幕移回螢幕下方", action: #selector(resetPosition), keyEquivalent: "")
        reset.target = self
        menu.addItem(reset)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "結束會議字幕", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    func submenu(_ title: String, _ items: [(String, CGFloat, Bool)], _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (name, value, on) in items {
            let m = NSMenuItem(title: name, action: action, keyEquivalent: "")
            m.target = self
            m.representedObject = NSNumber(value: Double(value))
            m.state = on ? .on : .off
            sub.addItem(m)
        }
        item.submenu = sub
        return item
    }

    @objc func pickAlpha(_ sender: NSMenuItem) {
        bgAlpha = CGFloat((sender.representedObject as? NSNumber)?.doubleValue ?? 0.25)
        rebuildMenu()
    }

    @objc func pickSize(_ sender: NSMenuItem) {
        fontSize = CGFloat((sender.representedObject as? NSNumber)?.doubleValue ?? 30)
        rebuildMenu()
    }

    @objc func toggleClickThrough() {
        panel.ignoresMouseEvents.toggle()
        defaults.set(panel.ignoresMouseEvents, forKey: "clickThrough")
        rebuildMenu()
    }

    @objc func toggleAlwaysShow() {
        defaults.set(!alwaysShow, forKey: "alwaysShow")
        updateVisibility()
        rebuildMenu()
    }

    @objc func resetPosition() {
        let screen = NSScreen.main?.visibleFrame ?? .zero
        var f = panel.frame
        f.size.width = min(900, screen.width * 0.6)
        f.origin = NSPoint(x: screen.midX - f.width / 2, y: screen.minY + 80)
        panel.setFrame(f, display: true)
        showUntil = Date().addingTimeInterval(4)   // 讓人看到移到哪裡
        updateVisibility()
        rebuildMenu()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

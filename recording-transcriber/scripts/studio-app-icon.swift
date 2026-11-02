// 字幕工作室 App 圖示：場記板＋字幕條（recording-transcriber#16）
// 改了圖就重新產生 assets/studio-app.icns，再跑 pnpm run studio:app：
//   swift scripts/studio-app-icon.swift /tmp/icon.png
//   mkdir /tmp/studio.iconset && for s in 16 32 128 256 512; do
//     sips -z $s $s /tmp/icon.png --out /tmp/studio.iconset/icon_${s}x${s}.png
//     sips -z $((s*2)) $((s*2)) /tmp/icon.png --out /tmp/studio.iconset/icon_${s}x${s}@2x.png; done
//   iconutil -c icns /tmp/studio.iconset -o assets/studio-app.icns
// 網頁的 logo 與 favicon（裁掉外圍透明邊）：
//   sips --cropToHeightWidth 840 840 /tmp/icon.png --out /tmp/crop.png && sips -z 192 192 /tmp/crop.png --out assets/studio-icon.png
import AppKit

let out = CommandLine.arguments[1]
let S: CGFloat = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let g = NSGraphicsContext.current!.cgContext
func rgb(_ h: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((h >> 16) & 255) / 255, green: CGFloat((h >> 8) & 255) / 255, blue: CGFloat(h & 255) / 255, alpha: a)
}
func rr(_ r: CGRect, _ c: CGFloat) -> CGPath { CGPath(roundedRect: r, cornerWidth: c, cornerHeight: c, transform: nil) }

// 底板：macOS 圖示格線 824×824，置中
let plate = CGRect(x: 100, y: 100, width: 824, height: 824)
g.saveGState()
g.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.35))
g.addPath(rr(plate, 185)); g.setFillColor(rgb(0xE8453C)); g.fillPath()
g.restoreGState()
g.saveGState()
g.addPath(rr(plate, 185)); g.clip()
let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(0xFF7A45), rgb(0xD62F5B)] as CFArray, locations: [0, 1])!
g.drawLinearGradient(grad, start: CGPoint(x: 0, y: 924), end: CGPoint(x: 0, y: 100), options: [])
g.restoreGState()

let ink = rgb(0x1F1D2B), white = rgb(0xFFFFFF)

// 場記板本體
let body = CGRect(x: 222, y: 180, width: 580, height: 372)
g.addPath(rr(body, 46)); g.setFillColor(ink); g.fillPath()

// 下半部斑馬條（貼在本體上緣）
let bar = CGRect(x: 222, y: 552, width: 580, height: 88)
func stripes(_ r: CGRect) {
  g.saveGState()
  g.addPath(rr(r, 20)); g.clip()
  g.setFillColor(ink); g.fill(r)
  g.setFillColor(white)
  let w: CGFloat = 70
  var x = r.minX - r.height
  while x < r.maxX + r.height {
    g.move(to: CGPoint(x: x, y: r.minY)); g.addLine(to: CGPoint(x: x + w, y: r.minY))
    g.addLine(to: CGPoint(x: x + w + r.height * 0.9, y: r.maxY)); g.addLine(to: CGPoint(x: x + r.height * 0.9, y: r.maxY))
    g.closePath(); g.fillPath()
    x += w * 2
  }
  g.restoreGState()
}
stripes(bar)

// 上蓋：以左端為軸往上翹
let lid = CGRect(x: 222, y: 656, width: 580, height: 88)
g.saveGState()
g.translateBy(x: 236, y: 656)
g.rotate(by: 10 * .pi / 180)
g.translateBy(x: -236, y: -656)
stripes(lid)
g.restoreGState()
// 軸心
g.setFillColor(white); g.fillEllipse(in: CGRect(x: 214, y: 626, width: 44, height: 44))
g.setFillColor(ink); g.fillEllipse(in: CGRect(x: 226, y: 638, width: 20, height: 20))

// 播放鍵
g.setFillColor(white)
g.move(to: CGPoint(x: 466, y: 480)); g.addLine(to: CGPoint(x: 466, y: 368)); g.addLine(to: CGPoint(x: 563, y: 424)); g.closePath(); g.fillPath()

// 字幕條：黃色，兩行
g.setFillColor(rgb(0xFFD23F))
g.addPath(rr(CGRect(x: 300, y: 276, width: 424, height: 40), 20)); g.fillPath()
g.addPath(rr(CGRect(x: 370, y: 226, width: 284, height: 32), 16)); g.fillPath()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))

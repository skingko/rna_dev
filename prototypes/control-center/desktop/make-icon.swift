// Reproduces the application's existing blue R favicon as a macOS icon set.
import AppKit
import Foundation
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let pixels = size * scale, dimension = CGFloat(pixels)
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor(red: 111/255, green: 139/255, blue: 200/255, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: dimension*0.06, y: dimension*0.06, width: dimension*0.88, height: dimension*0.88), xRadius: dimension*0.21, yRadius: dimension*0.21).fill()
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont(name: "Georgia-Bold", size: dimension*0.74) ?? NSFont.boldSystemFont(ofSize: dimension*0.74), .foregroundColor: NSColor.white]
    let text = "R" as NSString, bounds = text.size(withAttributes: attributes)
    text.draw(at: NSPoint(x: (dimension-bounds.width)/2, y: (dimension-bounds.height)/2+dimension*0.015), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()
    let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(name))
  }
}

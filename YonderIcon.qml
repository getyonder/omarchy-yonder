import QtQuick
import QtQuick.Shapes
import qs.Commons
import qs.Commons as Commons

// Yonder's mark: this device (the filled dot), a device somewhere else (the
// ring) and the way between them (the dots). Drawn on a 22 by 22 grid, as
// packaging/tray-template.svg is.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Commons.Color.foreground

  readonly property real unit: iconSize / 22

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  Shape {
    anchors.fill: parent
    antialiasing: true
    layer.enabled: true
    layer.samples: 4

    ShapePath {
      fillColor: root.color
      strokeWidth: 0
      strokeColor: "transparent"
      PathAngleArc {
        centerX: 5 * root.unit; centerY: 16 * root.unit
        radiusX: 3 * root.unit; radiusY: 3 * root.unit
        startAngle: 0; sweepAngle: 360
      }
    }

    ShapePath {
      fillColor: "transparent"
      strokeColor: root.color
      strokeWidth: 2 * root.unit
      PathAngleArc {
        centerX: 17 * root.unit; centerY: 6 * root.unit
        radiusX: 3 * root.unit; radiusY: 3 * root.unit
        startAngle: 0; sweepAngle: 360
      }
    }

    ShapePath {
      fillColor: "transparent"
      strokeColor: root.color
      strokeWidth: 2 * root.unit
      capStyle: ShapePath.RoundCap
      strokeStyle: ShapePath.DashLine
      // In stroke widths: a dot, then a gap of two.
      dashPattern: [0.5, 2]
      startX: 8 * root.unit; startY: 13.5 * root.unit
      PathLine { x: 14 * root.unit; y: 8.5 * root.unit }
    }
  }
}

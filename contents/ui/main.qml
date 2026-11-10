import QtQuick
import QtQml.Models
import org.kde.kwin
import "../code/tiler.js" as Tiler

Item {
    id: root

    // Handle for this tiler instance. KWin does not disconnect a declarative
    // script's signal handlers when the script is unloaded, so the handle lets
    // the old instance deactivate itself instead of leaving a second tiler
    // behind after a reload.
    property var tilerHandle

    // Normalized keymaps read from config.json. Instantiator is used instead of
    // Repeater because ShortcutHandler is not an Item.
    property var keymaps: []

    Instantiator {
        model: root.keymaps
        delegate: ShortcutHandler {
            name: "Kazulejo: " + modelData.label
            text: modelData.label
            sequence: modelData.sequence
            onActivated: Tiler.runAction(modelData.action)
        }
    }

    // The tiler uses this timer to keep re-applying a floating rule's geometry
    // while a client finishes mapping. Polling covers clients whose mapping
    // signals were emitted before the tiler connected to them.
    Timer {
        id: placementTimer
        interval: 100
        repeat: true
        onTriggered: Tiler.pollPendingPlacements(root.tilerHandle)
    }

    Component.onDestruction: {
        Tiler.stop(root.tilerHandle)
        root.tilerHandle = null
        root.keymaps = []
    }

    Component.onCompleted: {
        root.tilerHandle = Tiler.start({
            workspace: Workspace,
            kwin: KWin,
            placementTimer: placementTimer,
        })
        root.keymaps = root.tilerHandle ? root.tilerHandle.config.keymaps : []
    }
}

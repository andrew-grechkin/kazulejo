.pragma library
.import "layouts/master-stack.js" as MasterStack

// Layout registry
//
// A layout turns the current set of tiled windows into placements. Tilers and
// config validation stay independent of a concrete layout; adding a layout
// means adding a module to ./layouts and registering it below.
//
// Layout module interface
// -----------------------
// Each layout module exports:
//
//   id: string
//       Stable identifier used in rules.json as defaults.layout.
//
//   label: string
//       Human-readable name.
//
//   defaults(): object
//       Layout-specific default options (normalized form).
//
//   normalizeDefaults(value): object
//       Validate the options from config.json and return the normalized object.
//       `value` never contains the layout identifier. Unknown options are
//       ignored. Throw an Error for invalid input.
//
//   summary(options): string
//       One-line description used by the `setup` preview.
//
//   arrange(context): Array<{ window, geometry }>
//       Return one placement per tiled window, in the order the tiler should
//       apply them. `geometry` is { x, y, width, height }.
//
//   resize(context): object | null
//       Optional. Called while a tiled window is interactively resized. Return
//       an updated runtime state (stored by the tiler per output and passed
//       back as `state`), or null when the resize does not change a split.
//       The resize context contains the arrange context plus `window`,
//       `geometry` (the current frame), and `baseline` (the frame at the start
//       of the drag).
//
// The arrange context contains:
//
//   windows: Array<Window>
//       Tiled windows on one output, in stable creation order.
//
//   area: { x, y, width, height }
//       Work area for the output and current desktop.
//
//   defaults: object
//       Normalized options returned by normalizeDefaults().
//
//   state: object | null
//       Runtime state previously returned by resize(), or null.
//
//   pinned: Array<Window>
//       Windows whose matched rule sets float:false. Layouts may use this to
//       keep user-pinned windows in a preferred slot.
//
//   minimums: Array<{ window, width, height }>
//       Client-enforced minimum sizes, in the same order as windows. Layouts
//       should avoid assigning a slot smaller than the minimum. When the
//       minima cannot all fit, the tiler still keeps each window on screen.
//
//   snapLeft: Window | null
//       Window dragged to the left snap zone, if any.
//
//   snapRight: Window | null
//       Window dragged to the right snap zone, if any.
//
// Layouts must not modify windows or rely on KWin-specific globals so the same
// module can be loaded by the config validator.

const defaultLayoutId = "master-stack";

const layouts = [
    MasterStack,
];

function defaultId() {
    return defaultLayoutId;
}

function ids() {
    return layouts.map((layout) => layout.id);
}

function find(id) {
    for (let i = 0; i < layouts.length; ++i) {
        if (layouts[i].id === id)
            return layouts[i];
    }

    return null;
}

function getDefault() {
    return find(defaultLayoutId);
}

function normalizeDefaults(id, value) {
    const layout = find(id);
    if (!layout)
        throw new Error("unknown layout: " + id);

    return layout.normalizeDefaults(value);
}

function summary(id, options) {
    const layout = find(id);
    if (!layout)
        return String(id);

    return layout.summary(options);
}

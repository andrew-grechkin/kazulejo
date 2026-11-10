.pragma library
.import "actions.js" as Actions
.import "layout.js" as Layout

"use strict";

// Used only when a tiled window becomes floating without a remembered
// geometry, e.g. windows that were already tiled when the script loaded.
const DEFAULT_FLOAT_WIDTH_RATIO = 0.6;
const DEFAULT_FLOAT_HEIGHT_RATIO = 0.7;

// Runtime overrides set by dragging or the toggle-floating keymap. They take
// precedence over the configured rule until the script is reloaded.
const forcedFloatingWindows = [];
const forcedTiledWindows = [];
const movingWindows = [];
// Geometry at the start of an interactive resize. Comparing the current frame
// against it tells which tile boundary the user moved.
const resizeGeometries = [];
// Opaque split state owned by the current layout, kept per output so resizing
// on one monitor does not change another monitor's layout.
const layoutStates = [];
// Windows KWin asked to maximize while their move was finishing. This is how
// the top-edge snap appears; the committed maximize state can arrive after the
// move-finished signal on Wayland.
const snapMaximizedWindows = [];

// Windows explicitly moved into the left or right snap zone. The layout decides
// how to interpret those sides; master-stack, for example, maps left to the
// master column and right to the first stack slot.
let snapLeftWindow = null;
let snapRightWindow = null;
// Windows whose below layer was set by the tiler. When they become floating
// without a layer rule, only this tiler-imposed change is reverted.
const tiledLayerWindows = [];

// Geometry to restore when a tiled window becomes floating. KWin does not
// expose the application's preferred size to scripts, and windows placed by
// the tiler have no quick-tile restore geometry, so remember the geometry from
// before the tiler first touched a window and keep it current while floating.
const floatingGeometries = [];

// Asking a maximized window to restore emits maximizedChanged while the
// maximize effect animates. Re-requesting the restore on every arrange pass
// restarts that animation, so wait for the restored state before asking again.
const restoreRequests = [];

// The client can overwrite the rule geometry while it starts up. Floating
// windows are not part of arrange(), so without this their configured
// size/position would be lost and they would keep their default startup
// geometry. Pending placements also keep the window hidden in the compositor
// until the first committed frame has the final geometry. Tiled windows use
// the same mechanism: they stay hidden until arrange() has placed them in
// their slot, so the client's startup frame is never presented. If the client
// refuses the slot, the window is revealed after the hide timeout but the
// placement keeps retrying until the grace period expires.
const pendingPlacements = [];
const MAX_PLACEMENT_ATTEMPTS = 10;
// Clients such as WezTerm apply their own startup size shortly after mapping,
// sometimes after the rule geometry already matched once. Keep enforcing the
// rule for a short grace period instead of dropping it on the first match.
const PLACEMENT_GRACE_MS = 3000;
// Do not keep a window invisible indefinitely if a client refuses the rule
// geometry. Reveal it after this long and let the normal retries continue.
const PLACEMENT_HIDE_TIMEOUT_MS = 1000;

function log(message) {
    console.log("kazulejo: " + message);
}

function logError(message) {
    console.error("kazulejo: " + message);
}

function describeWindow(window) {
    return "class=" + (window.resourceClass || "?") +
        " name=" + (window.resourceName || "?");
}

// Log the flags that decide whether a window is a popup. This is intentionally
// only used for add/remove events to keep placement logs compact.
function describeWindowFlags(window) {
    const names = [
        "specialWindow", "popupWindow", "dropdownMenu", "popupMenu",
        "tooltip", "notification", "criticalNotification", "appletPopup",
        "onScreenDisplay", "comboBox", "dndIcon", "outline", "dock",
        "desktopWindow", "transient", "modal", "dialog", "utility", "splash",
    ];
    const flags = [];

    for (const name of names) {
        if (window[name])
            flags.push(name);
    }

    if (window.resizeable === false)
        flags.push("resizeable=false");
    if (typeof window.windowType === "number")
        flags.push("windowType=" + window.windowType);
    if (typeof window.pid === "number")
        flags.push("pid=" + window.pid);

    return flags.length > 0 ? flags.join(",") : "none";
}

function formatGeometry(geometry) {
    if (!geometry)
        return "none";
    return geometry.x + "," + geometry.y + " " +
        geometry.width + "x" + geometry.height;
}

function copyGeometry(geometry) {
    if (!geometry || geometry.width <= 0 || geometry.height <= 0)
        return null;

    return {
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
    };
}

function saveFloatingGeometry(window, geometry) {
    if (!window || window.deleted)
        return;

    const copy = copyGeometry(geometry);
    if (!copy)
        return;

    for (let i = 0; i < floatingGeometries.length; ++i) {
        if (floatingGeometries[i].window === window) {
            floatingGeometries[i].geometry = copy;
            return;
        }
    }

    floatingGeometries.push({ window: window, geometry: copy });
}

function savedFloatingGeometry(window) {
    for (let i = 0; i < floatingGeometries.length; ++i) {
        if (floatingGeometries[i].window === window)
            return floatingGeometries[i].geometry;
    }

    return null;
}

function forgetFloatingGeometry(window) {
    for (let i = floatingGeometries.length - 1; i >= 0; --i) {
        if (floatingGeometries[i].window === window)
            floatingGeometries.splice(i, 1);
    }
}

function rememberResizeGeometry(window, layoutState) {
    if (!window || window.deleted)
        return;

    const geometry = copyGeometry(window.frameGeometry);
    if (!geometry)
        return;

    for (let i = 0; i < resizeGeometries.length; ++i) {
        if (resizeGeometries[i].window === window) {
            resizeGeometries[i].geometry = geometry;
            resizeGeometries[i].layoutState = layoutState;
            return;
        }
    }

    resizeGeometries.push({
        window: window,
        geometry: geometry,
        layoutState: layoutState,
    });
}

function resizeGeometryFor(window) {
    for (let i = 0; i < resizeGeometries.length; ++i) {
        if (resizeGeometries[i].window === window)
            return resizeGeometries[i].geometry;
    }

    return null;
}

function resizeLayoutStateFor(window) {
    for (let i = 0; i < resizeGeometries.length; ++i) {
        if (resizeGeometries[i].window === window)
            return resizeGeometries[i].layoutState;
    }

    return null;
}

function forgetResizeGeometry(window) {
    for (let i = resizeGeometries.length - 1; i >= 0; --i) {
        if (resizeGeometries[i].window === window)
            resizeGeometries.splice(i, 1);
    }
}

// Restore the geometry a window had before it was tiled. The saved geometry can
// be on another output or outside the current work area after a screen layout
// change, so keep it visible. When no geometry was recorded (for example for
// windows that were already tiled when the script loaded), fall back to a
// sensible floating size instead of keeping the narrow tile slot.
function restoreFloatingGeometry(window, workspace) {
    if (!window || window.deleted)
        return false;

    const area = workspace.clientArea(clientAreaOption(workspace), window.output, workspace.currentDesktop);
    const saved = savedFloatingGeometry(window);

    if (!saved && (!area || area.width <= 0 || area.height <= 0))
        return false;

    let width;
    let height;
    let x;
    let y;

    if (saved) {
        width = saved.width;
        height = saved.height;
        x = saved.x;
        y = saved.y;
    }
    else {
        width = area.width * DEFAULT_FLOAT_WIDTH_RATIO;
        height = area.height * DEFAULT_FLOAT_HEIGHT_RATIO;
        x = area.x + (area.width - width) / 2;
        y = area.y + (area.height - height) / 2;
    }

    if (area && area.width > 0 && area.height > 0) {
        width = Math.min(width, area.width);
        height = Math.min(height, area.height);
        x = clamp(x, area.x, area.x + area.width - width);
        y = clamp(y, area.y, area.y + area.height - height);
    }

    const geometry = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    };

    saveFloatingGeometry(window, geometry);

    if (sameGeometry(window.frameGeometry, geometry))
        return true;

    log("float restore " + describeWindow(window) +
        " current=" + formatGeometry(window.frameGeometry) +
        " target=" + formatGeometry(geometry));
    window.frameGeometry = Qt.rect(geometry.x, geometry.y, geometry.width, geometry.height);
    return true;
}

// A newly added window may already have emitted every mapping signal before
// the deferred apply() runs, so waiting for another signal can leave the rule
// geometry unapplied. Poll pending placements until they are committed, the
// grace period ends, or the user takes over.
//
// The declarative entry point owns a QML Timer and passes it in through start().
let placementTimer = null;

function pollPendingPlacements(state) {
    if (!isActive(state))
        return;

    const windows = pendingPlacements.map((pending) => pending.window);
    for (let i = 0; i < windows.length; ++i)
        settlePendingPlacement(windows[i]);

    // A client can discard the configure that arrange() sent during
    // windowAdded, for example while KWin is still applying its own placement
    // policy. The geometry then never changes, so no frameGeometryChanged
    // signal arrives and the tiler would give up without ever retrying. Keep
    // running arrange() from the timer while a tiled placement is pending;
    // settleTiledPlacement() stops this after the grace period.
    for (let i = 0; i < pendingPlacements.length; ++i) {
        if (pendingPlacements[i].tiled) {
            if (state.schedule)
                state.schedule();
            break;
        }
    }

    if (pendingPlacements.length === 0 && placementTimer)
        placementTimer.stop();
}

function startPlacementTimer() {
    if (placementTimer && !placementTimer.active)
        placementTimer.start();
}

function rulesConfig(api) {
    return api.kwin.readConfig("rules", "");
}

function defaultConfig() {
    const layout = Layout.getDefault();

    return {
        layout: layout,
        defaults: layout.defaults(),
        keymaps: [],
        rules: [],
    };
}

function parseConfig(raw) {
    const config = defaultConfig();

    if (!raw)
        return config;

    try {
        const parsed = JSON.parse(raw);
        const rawDefaults = parsed.defaults || {};
        const layoutId = typeof rawDefaults.layout === "string"
            ? rawDefaults.layout
            : config.layout.id;
        const layout = Layout.find(layoutId);

        if (layout)
            config.layout = layout;
        else
            logError("unknown layout \"" + layoutId + "\"; using " + config.layout.id);

        const options = {};
        const keys = Object.keys(rawDefaults);
        for (let i = 0; i < keys.length; ++i) {
            if (keys[i] !== "layout")
                options[keys[i]] = rawDefaults[keys[i]];
        }

        try {
            config.defaults = config.layout.normalizeDefaults(options);
        }
        catch (error) {
            logError("invalid layout defaults: " + error);
            config.defaults = config.layout.defaults();
        }

        if (Array.isArray(parsed.rules))
            config.rules = parsed.rules;

        if (parsed.keymaps !== undefined) {
            try {
                config.keymaps = Actions.normalizeKeymaps(parsed.keymaps);
            }
            catch (error) {
                logError("invalid keymaps: " + error);
            }
        }
    }
    catch (error) {
        logError("invalid rules: " + error);
    }

    return config;
}

function matchesClass(window, expected) {
    const classes = Array.isArray(expected) ? expected : [expected];
    return classes.some((name) => name === window.resourceClass || name === window.resourceName);
}

function matches(window, rule) {
    const match = rule.match || {};
    const caption = window.caption || "";

    if (match.class && !matchesClass(window, match.class))
        return false;

    if (match.title && !caption.toLowerCase().includes(match.title.toLowerCase()))
        return false;

    return Boolean(match.class || match.title);
}

// Floating rules win over tiling rules regardless of their position in the
// config. A broad class rule such as "opera" must not tile a more specific
// floating window just because it appears first.
function ruleFor(window, rules) {
    for (const rule of rules) {
        if (rule.float === true && matches(window, rule))
            return rule;
    }

    for (const rule of rules) {
        if (matches(window, rule))
            return rule;
    }

    return null;
}

function isPopupWindow(window) {
    return Boolean(
        window.specialWindow ||
            window.popupWindow ||
            window.dropdownMenu ||
            window.popupMenu ||
            window.tooltip ||
            window.notification ||
            window.criticalNotification ||
            window.appletPopup ||
            window.onScreenDisplay ||
            window.comboBox ||
            window.dndIcon ||
            window.outline ||
            window.dock ||
            window.desktopWindow
    );
}

// Popups and transients are owned by another window and must never participate
// in tiling, even when a class rule matches their application. Without this,
// a class rule such as "opera" tiles YouTube's hover preview windows.
function isAlwaysFloating(window) {
    return isPopupWindow(window) || Boolean(window.transient);
}

// Windows that float without an explicit rule. Besides popups and transients,
// this covers dialogs, utilities, splash screens, and KWin's own internal
// windows. Rules that do not mention float must leave these windows floating.
function floatsByDefault(window) {
    return isAlwaysFloating(window) || Boolean(
        window.resourceClass === "plasmashell" ||
            // KWin's own desktop-switch OSD/effect windows are managed windows
            // with no application class and pid -1. They must not be tiled.
            window.pid === -1 ||
            window.modal ||
            !window.resizeable ||
            window.dialog ||
            window.utility ||
            window.splash
    );
}

function shouldFloat(window, rule) {
    if (forcedFloatingWindows.indexOf(window) !== -1)
        return true;
    if (forcedTiledWindows.indexOf(window) !== -1)
        return false;

    // Only an explicit float:false rule may pull a window that floats by
    // itself into the tiling layout. A rule that omits float leaves it alone.
    if (rule && rule.float === false)
        return false;
    if (floatsByDefault(window))
        return true;
    if (rule)
        return rule.float === true;

    return false;
}

// Minimizing a tiled window contradicts the layout: the window disappears and
// the remaining tiles reflow. KWin makes `minimized` writable, so undo the
// request before the deferred arrange runs. Floating windows keep the normal
// minimize behavior.
function preventTiledMinimize(window, rules) {
    if (!window || window.deleted || !window.minimized)
        return false;

    if (shouldFloat(window, ruleFor(window, rules)))
        return false;

    log("unminimize " + describeWindow(window) +
        " caption=\"" + (window.caption || "") + "\"");

    window.minimized = false;

    if (window.minimized)
        logError("could not unminimize " + describeWindow(window));

    return true;
}

function resolveDimension(dimension, size) {
    return dimension.unit === "%" ? (size * dimension.value) / 100 : dimension.value;
}

// In KWin 6 the ClientAreaOption enum is exposed on Workspace.
// MaximizeArea is per-output and respects panels and other struts. WorkArea is
// the combined area of all screens, so it must not be used for per-output
// tiling.
function clientAreaOption(workspace) {
    if (typeof workspace.MaximizeArea === "number")
        return workspace.MaximizeArea;
    if (typeof workspace.WorkArea === "number")
        return workspace.WorkArea;

    // ClientAreaOption::MaximizeArea in the current KWin 6 enum layout.
    return 2;
}

function geometryFor(window, rule, workspace) {
    if (!rule.position && !rule.size)
        return null;

    const area = workspace.clientArea(clientAreaOption(workspace), window.output, workspace.currentDesktop);
    if (!area || area.width <= 0 || area.height <= 0)
        return null;

    const current = window.frameGeometry;
    // A fullscreen window's frame is the whole screen. When a rule omits a
    // dimension, fall back to the geometry the window had before going
    // fullscreen instead of inheriting the fullscreen size.
    const baseline = window.fullScreen
        ? (savedFloatingGeometry(window) || current)
        : current;
    const position = rule.position || {};
    const size = rule.size || {};

    const width = size.width != null ? resolveDimension(size.width, area.width) : baseline.width;
    const height = size.height != null ? resolveDimension(size.height, area.height) : baseline.height;

    // A rule that only sets the size must not inherit the client's startup
    // position: center the window on every axis without an explicit position.
    // Otherwise a large default window shrinks into its old top-left corner.
    const x = position.left != null
        ? area.x + resolveDimension(position.left, area.width)
        : area.x + (area.width - width) / 2;
    const y = position.top != null
        ? area.y + resolveDimension(position.top, area.height)
        : area.y + (area.height - height) / 2;

    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    };
}

// KWin updates a window's frame geometry before it flips the fullScreen
// property (and emits fullScreenChanged) when a client goes fullscreen.
// Recognize the screen-sized frame so a pending rule placement does not
// overwrite it during that gap. FullScreenArea is the whole screen; MaximizeArea
// excludes panels, so it cannot be used here.
function fullScreenAreaOption(workspace) {
    if (workspace && typeof workspace.FullScreenArea === "number")
        return workspace.FullScreenArea;
    if (typeof KWin !== "undefined" && typeof KWin.FullScreenArea === "number")
        return KWin.FullScreenArea;

    // ClientAreaOption::FullScreenArea in the current KWin 6 enum layout.
    return 4;
}

function isFullScreenGeometry(window, workspace) {
    if (!window || !workspace)
        return false;

    const area = workspace.clientArea(
        fullScreenAreaOption(workspace),
        window.output,
        workspace.currentDesktop
    );
    if (!area || area.width <= 0 || area.height <= 0)
        return false;

    return sameGeometry(window.frameGeometry, area);
}

function forgetPendingPlacement(window, reason) {
    for (let i = pendingPlacements.length - 1; i >= 0; --i) {
        if (pendingPlacements[i].window === window) {
            log("placement cancel " + describeWindow(window) +
                " reason=" + reason +
                " current=" + formatGeometry(window.frameGeometry));
            revealPendingPlacement(pendingPlacements[i]);
            pendingPlacements.splice(i, 1);
        }
    }
}

// Workspace.windowAdded is emitted only after the Wayland client committed its
// first buffer, so the client's large startup frame would already be visible
// before the rule geometry reaches it. Hide the window in the compositor while
// the geometry is pending: the first frame the user can see is then the one at
// the final size and position. The original opacity is restored on reveal.
function hidePendingPlacement(pending) {
    if (pending.hidden || pending.window.deleted)
        return;

    pending.opacity = pending.window.opacity;
    pending.hidden = true;
    pending.window.opacity = 0;
    log("placement hide " + describeWindow(pending.window) +
        " opacity=" + pending.opacity);
}

function revealPendingPlacement(pending) {
    if (!pending.hidden || pending.window.deleted)
        return;

    pending.hidden = false;
    pending.window.opacity = pending.opacity;
    log("placement reveal " + describeWindow(pending.window) +
        " opacity=" + pending.opacity +
        " current=" + formatGeometry(pending.window.frameGeometry));
}

function queuePendingPlacement(window, rules, workspace) {
    const rule = ruleFor(window, rules);
    if (!rule || !shouldFloat(window, rule))
        return;

    if (!rule.position && !rule.size)
        return;

    const geometry = geometryFor(window, rule, workspace);
    if (!geometry)
        return;

    forgetPendingPlacement(window, "requeue");

    const pending = {
        window: window,
        rule: rule,
        workspace: workspace,
        attempts: 0,
        matched: false,
        createdAt: Date.now(),
        hidden: false,
        opacity: 1,
    };

    hidePendingPlacement(pending);
    pendingPlacements.push(pending);
    log("placement queue " + describeWindow(window) +
        " target=" + formatGeometry(geometry));
    startPlacementTimer();
}

// Hide a newly added tiled window until arrange() has put it in its slot. The
// target geometry is owned by the layout, so arrange() records it on the
// pending entry as it places the window.
function queueTilePlacement(window, workspace) {
    if (!window || window.deleted)
        return;

    // Windows placed on another desktop are not visible now. arrange() only
    // tiles windows on the current desktop, so hiding them would leave them
    // invisible until the user switches.
    if (!isOnCurrentDesktop(window, workspace))
        return;

    // A fullscreen window is not part of the layout, so there is no tile slot
    // to wait for.
    if (window.fullScreen)
        return;

    forgetPendingPlacement(window, "requeue");

    const pending = {
        window: window,
        workspace: workspace,
        tiled: true,
        target: null,
        createdAt: Date.now(),
        hidden: false,
        opacity: 1,
    };

    hidePendingPlacement(pending);
    pendingPlacements.push(pending);
    log("placement queue tiled " + describeWindow(window));
    startPlacementTimer();
}

function pendingPlacementFor(window) {
    for (let i = 0; i < pendingPlacements.length; ++i) {
        if (pendingPlacements[i].window === window)
            return pendingPlacements[i];
    }

    return null;
}

// A window that goes fullscreen owns its geometry. Drop a floating rule
// placement that is still being enforced, otherwise it would re-apply the rule
// over the fullscreen frame (and, for a rule without an explicit height, use
// the fullscreen height for the missing dimension).
function cancelPendingPlacementForFullscreen(window) {
    if (!window || window.deleted || !window.fullScreen)
        return false;
    if (!pendingPlacementFor(window))
        return false;

    forgetPendingPlacement(window, "fullscreen");
    return true;
}

// Tiled windows are revealed as soon as the layout geometry has been committed.
// If the client refuses it, reveal anyway after the short hide timeout rather
// than keeping the window invisible, but keep the placement pending so the
// timer can retry arrange() until the grace period ends.
function settleTiledPlacement(pending, index) {
    const window = pending.window;
    const age = Date.now() - pending.createdAt;

    if (!window || window.deleted) {
        pendingPlacements.splice(index, 1);
        return false;
    }

    if (pending.target && sameGeometry(window.frameGeometry, pending.target)) {
        log("placement settled " + describeWindow(window) +
            " age=" + age +
            " current=" + formatGeometry(window.frameGeometry) +
            " target=" + formatGeometry(pending.target));
        revealPendingPlacement(pending);
        pendingPlacements.splice(index, 1);
        return true;
    }

    if (age >= PLACEMENT_GRACE_MS) {
        log("placement abandoned " + describeWindow(window) +
            " age=" + age +
            " current=" + formatGeometry(window.frameGeometry) +
            " target=" + formatGeometry(pending.target));
        revealPendingPlacement(pending);
        pendingPlacements.splice(index, 1);
        return false;
    }

    if (age >= PLACEMENT_HIDE_TIMEOUT_MS)
        revealPendingPlacement(pending);

    // Returning false lets the frameGeometryChanged handler schedule another
    // arrange pass. pollPendingPlacements() also retries while the timer is
    // running, which covers clients that never emit that signal.
    return false;
}

// Re-apply a new window's rule geometry until KWin has committed it or the
// user takes over by moving/resizing the window. Returns true when the window
// still has a pending placement, so the change is not treated as user input.
// The geometry is recomputed each time: an omitted position is always centered
// on the work area, so retries do not drift.
function settlePendingPlacement(window) {
    // Done before the loop: forgetting the placement rewrites the array.
    if (cancelPendingPlacementForFullscreen(window))
        return false;

    for (let i = 0; i < pendingPlacements.length; ++i) {
        const pending = pendingPlacements[i];
        if (pending.window !== window)
            continue;

        if (pending.tiled)
            return settleTiledPlacement(pending, i);

        const age = Date.now() - pending.createdAt;
        const expired = age >= PLACEMENT_GRACE_MS;
        const geometry = geometryFor(window, pending.rule, pending.workspace);

        if (expired || pending.attempts >= MAX_PLACEMENT_ATTEMPTS) {
            const current = window.frameGeometry;
            const settled = geometry && sameGeometry(current, geometry);
            log("placement " + (settled ? "settled " : "abandoned ") +
                describeWindow(window) +
                " age=" + age +
                " attempts=" + pending.attempts +
                " current=" + formatGeometry(current) +
                " target=" + formatGeometry(geometry));
            revealPendingPlacement(pending);
            pendingPlacements.splice(i, 1);
            return true;
        }

        if (!geometry) {
            ++pending.attempts;
            return true;
        }

        // Stay pending even when the geometry currently matches: the client
        // may still overwrite it while the grace period is running. Reveal as
        // soon as the final geometry has been committed, though, so a window
        // is never left invisible for the whole grace period.
        if (sameGeometry(window.frameGeometry, geometry)) {
            pending.matched = true;
            revealPendingPlacement(pending);
            return true;
        }

        // Once the rule geometry has been committed, a later screen-sized
        // frame means the window is going fullscreen. A startup frame that
        // large is already handled before the first match, so do not confuse
        // the two. The same-geometry check above keeps a rule that legitimately
        // covers the whole screen from being mistaken for fullscreen.
        if (pending.matched && isFullScreenGeometry(window, pending.workspace)) {
            forgetPendingPlacement(window, "fullscreen");
            return false;
        }

        // A client that never accepts the size must not stay invisible.
        if (age >= PLACEMENT_HIDE_TIMEOUT_MS)
            revealPendingPlacement(pending);

        ++pending.attempts;
        log("placement apply " + describeWindow(window) +
            " age=" + age +
            " attempt=" + pending.attempts +
            " current=" + formatGeometry(window.frameGeometry) +
            " target=" + formatGeometry(geometry));
        window.frameGeometry = Qt.rect(
            geometry.x,
            geometry.y,
            geometry.width,
            geometry.height
        );
        return true;
    }

    return false;
}

function desktopFor(rule, workspace) {
    if (!rule || rule.desktop == null || rule.desktop === "all")
        return null;

    return (workspace.desktops || [])[rule.desktop - 1] || null;
}

function applyDesktop(window, rule, workspace) {
    if (rule.desktop == null)
        return;

    if (rule.desktop === "all") {
        window.onAllDesktops = true;
        return;
    }

    const desktop = desktopFor(rule, workspace);
    if (!desktop)
        return;

    window.onAllDesktops = false;
    window.desktops = [desktop];
}

function sameDesktop(a, b) {
    if (a === b)
        return true;
    if (!a || !b || a.id == null || b.id == null)
        return false;

    return a.id === b.id;
}

// Switching desktops is only done when a window is created, never when it is
// moved or otherwise re-applied.
function followWindow(window, rules, workspace) {
    const rule = ruleFor(window, rules);
    if (!rule || rule.follow !== true)
        return;

    const desktop = desktopFor(rule, workspace);
    if (!desktop || sameDesktop(workspace.currentDesktop, desktop))
        return;

    workspace.currentDesktop = desktop;
}

function applyRule(window, rule, workspace, floating) {
    if (!window || window.deleted)
        return;

    applyDesktop(window, rule, workspace);

    // Position, size, and layer only make sense while the window is floating.
    if (!floating)
        return;

    if (rule.layer === "above") {
        window.keepAbove = true;
        window.keepBelow = false;
        forgetWindow(tiledLayerWindows, window);
    }
    else if (rule.layer === "below") {
        window.keepBelow = true;
        window.keepAbove = false;
        forgetWindow(tiledLayerWindows, window);
    }

    const geometry = geometryFor(window, rule, workspace);
    if (geometry)
        window.frameGeometry = Qt.rect(geometry.x, geometry.y, geometry.width, geometry.height);
}

// Tiled windows live below every floating window by default, so dialogs,
// popups, and explicitly floated applications always appear on top of them.
// Remember which windows received this layer so it can be reverted without
// touching layers that the window or a rule set on its own.
function setTiledLayer(window) {
    window.keepBelow = true;
    window.keepAbove = false;

    if (tiledLayerWindows.indexOf(window) === -1)
        tiledLayerWindows.push(window);
}

function clearTiledLayer(window) {
    if (tiledLayerWindows.indexOf(window) === -1)
        return;

    window.keepBelow = false;
    forgetWindow(tiledLayerWindows, window);
}

function applyWindow(window, rules, workspace) {
    const rule = ruleFor(window, rules);
    const floating = shouldFloat(window, rule);

    // Floating windows must not stay in KWin's maximized state; otherwise a
    // rule that intentionally floats a window would still fill the screen.
    if (floating && isMaximized(window))
        requestRestore(window);

    if (rule)
        applyRule(window, rule, workspace, floating);

    if (floating) {
        // Leave the layer alone unless a rule set it. Only revert the below
        // layer that this tiler applied while the window was tiled.
        if (!rule || !rule.layer)
            clearTiledLayer(window);
    } else {
        setTiledLayer(window);
    }
}

function requestRestore(window) {
    if (restoreRequests.indexOf(window) !== -1)
        return;

    restoreRequests.push(window);
    window.setMaximize(false, false);
}

function clearRestoreRequest(window) {
    forgetWindow(restoreRequests, window);
}

function setFloatOverride(window, floating) {
    forgetWindow(forcedFloatingWindows, window);
    forgetWindow(forcedTiledWindows, window);

    if (floating)
        forcedFloatingWindows.push(window);
    else
        forcedTiledWindows.push(window);
}

function toggleFloating(window, rules, workspace) {
    if (!window || window.deleted)
        return;

    const floating = shouldFloat(window, ruleFor(window, rules));
    setFloatOverride(window, !floating);

    // A rule with position/size still wins in applyWindow(); otherwise return
    // the window to the geometry it had before it was tiled.
    if (!floating)
        restoreFloatingGeometry(window, workspace);

    applyWindow(window, rules, workspace);
}

// KWin shows the snap marker (the gray preview rectangle) while a dragged
// window is inside an electric-border zone, and applies the snap when the move
// ends. Merely touching a work-area edge is not a snap: the window can start
// there or be dragged along the edge without the marker ever appearing. Check
// the state KWin applied at the end of the move instead.
function isWindowSnapped(window) {
    // Quick tiles (including custom Shift+drag tiles) are represented by a
    // Tile object on the window.
    if (window.tile)
        return true;

    // The top edge snaps to a maximized window. snapMaximizedWindows covers the
    // case where the committed maximize state has not arrived yet.
    return isMaximized(window);
}

// A quick tile's relative geometry tells which side of the output it occupies.
// Top/bottom and maximize snaps are full width, so they have no horizontal side.
function snapSide(window) {
    const tile = window.tile;
    if (!tile)
        return null;

    const geometry = tile.relativeGeometry;
    if (!geometry || geometry.width <= 0)
        return null;

    const center = geometry.x + geometry.width / 2;
    if (center < 0.5)
        return "left";
    if (center > 0.5)
        return "right";
    return null;
}

function applySnapSide(window, side) {
    if (side === "left") {
        snapLeftWindow = window;
        if (snapRightWindow === window)
            snapRightWindow = null;
    }
    else if (side === "right") {
        snapRightWindow = window;
        if (snapLeftWindow === window)
            snapLeftWindow = null;
    }
}

// The tiler places tiled windows itself, so drop KWin's quick-tile ownership.
// Otherwise KWin keeps treating the window as snapped and may re-apply the
// snapped geometry or resize the old tile instead of the window.
function releaseQuickTile(window) {
    const tile = window.tile;
    if (!tile)
        return;

    if (typeof tile.unmanage === "function")
        tile.unmanage(window);
    else
        window.tile = null;
}

// Dragging a tiled window detaches it from the layout and floats it. The
// remaining tiles are rearranged immediately, so the freed space is filled
// while the window is still under the cursor.
function beginWindowMove(window, rules, workspace) {
    if (!window || window.deleted)
        return;

    // Remember where a floating window was before it gets snapped into the
    // layout, so a later drag restores that geometry instead of the snapped one.
    if (shouldFloat(window, ruleFor(window, rules))) {
        saveFloatingGeometry(window, window.frameGeometry);
        return;
    }

    setFloatOverride(window, true);
    restoreFloatingGeometry(window, workspace);
    applyWindow(window, rules, workspace);
}

// Dropping a floating window on a KWin snap zone tiles it again. A tiled window
// that was resized (rather than moved) is snapped back by the caller's
// arrange().
function finishWindowMove(window, rules, workspace) {
    const wasMoved = movingWindows.indexOf(window) !== -1;
    const wasSnappedMaximize = snapMaximizedWindows.indexOf(window) !== -1;
    forgetWindow(movingWindows, window);
    forgetWindow(snapMaximizedWindows, window);

    if (!window || window.deleted)
        return;

    const floating = shouldFloat(window, ruleFor(window, rules));

    // A completed resize of a floating window is its new remembered geometry.
    // The resized geometry of a tiled window is discarded by arrange().
    if (!wasMoved) {
        if (floating)
            saveFloatingGeometry(window, window.frameGeometry);
        return;
    }

    if (!floating)
        return;

    // A plain floating move ends at the drop position. Do not overwrite the
    // pre-move geometry when the window was snapped and is about to be tiled.
    if (!wasSnappedMaximize && !isWindowSnapped(window)) {
        saveFloatingGeometry(window, window.frameGeometry);
        return;
    }

    const side = snapSide(window);
    releaseQuickTile(window);
    applySnapSide(window, side);
    setFloatOverride(window, false);
    applyWindow(window, rules, workspace);
}

function isOnCurrentDesktop(window, workspace) {
    if (window.onAllDesktops)
        return true;

    const current = workspace.currentDesktop;
    if (!current)
        return true;

    return (window.desktops || []).some((desktop) =>
        desktop === current || (desktop && current && desktop.id === current.id)
    );
}

function isOnCurrentActivity(window, workspace) {
    const activities = window.activities || [];
    return activities.length === 0 || activities.indexOf(workspace.currentActivity) !== -1;
}

function sameOutput(window, output) {
    return window.output === output ||
        (window.output && output && window.output.name === output.name);
}

function layoutStateEntry(output) {
    for (let i = 0; i < layoutStates.length; ++i) {
        const known = layoutStates[i].output;
        if (known === output || (known && output && known.name === output.name))
            return layoutStates[i];
    }

    return null;
}

function runtimeLayoutState(output) {
    const entry = layoutStateEntry(output);
    return entry ? entry.state : null;
}

function setRuntimeLayoutState(output, state) {
    const entry = layoutStateEntry(output);
    if (entry) {
        entry.state = state;
        return;
    }

    layoutStates.push({ output: output, state: state });
}

// KWin 6 exposes maximizeMode (0 = restored, 1 = vertical, 2 = horizontal,
// 3 = full) instead of the old boolean maximized property.
function maximizeMode(window) {
    return typeof window.maximizeMode === "number" ? window.maximizeMode : 0;
}

function isMaximized(window) {
    return maximizeMode(window) !== 0;
}

function tileableWindows(windows, workspace, output, rules) {
    return windows.filter((window) => {
        if (!window || window.deleted || window.minimized || window.fullScreen)
            return false;
        if (!sameOutput(window, output))
            return false;
        if (!isOnCurrentDesktop(window, workspace) || !isOnCurrentActivity(window, workspace))
            return false;

        return !shouldFloat(window, ruleFor(window, rules));
    });
}

// Windows with an explicit float:false rule are user-pinned tiles. Layouts can
// use this to keep them in a preferred slot.
function pinnedWindows(windows, rules) {
    return windows.filter((window) => {
        const rule = ruleFor(window, rules);
        return rule && rule.float === false;
    });
}

// KWin reports frame geometry with fractional values on scaled outputs. A
// requested integer size can come back as e.g. 531.111 px, so exact equality
// would never settle and the shrink-then-move placement below would loop in
// its first phase forever. Treat sub-pixel differences as the same geometry.
const GEOMETRY_TOLERANCE = 1;

function sameGeometry(current, expected) {
    return Math.abs(current.x - expected.x) <= GEOMETRY_TOLERANCE &&
        Math.abs(current.y - expected.y) <= GEOMETRY_TOLERANCE &&
        Math.abs(current.width - expected.width) <= GEOMETRY_TOLERANCE &&
        Math.abs(current.height - expected.height) <= GEOMETRY_TOLERANCE;
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

// A client can refuse a slot smaller than its own minimum size. Requesting the
// layout geometry directly then leaves the window wider than its slot: the
// shrink phase below never completes and the window stays at its temporary
// position, overlapping its neighbours. Grow the target to the client minimum
// and keep the resulting frame inside the work area.
function placementTarget(window, geometry, area) {
    const minimum = window.minSize;
    const minWidth = minimum && minimum.width > 0 ? Math.ceil(minimum.width) : 1;
    const minHeight = minimum && minimum.height > 0 ? Math.ceil(minimum.height) : 1;
    const width = Math.max(Math.round(geometry.width), minWidth);
    const height = Math.max(Math.round(geometry.height), minHeight);
    const maxX = area.x + Math.max(0, area.width - Math.min(width, area.width));
    const maxY = area.y + Math.max(0, area.height - Math.min(height, area.height));

    return {
        x: Math.round(clamp(geometry.x, area.x, maxX)),
        y: Math.round(clamp(geometry.y, area.y, maxY)),
        width: width,
        height: height,
    };
}

// Place a tiled window without ever putting a transient geometry across a
// work-area edge. Clients such as WezTerm apply the move and the resize in
// separate commits, so a large window moved directly into a narrow stack slot
// can briefly extend past the right edge. Shrink first at a safe position, then
// move to the final slot once the new size has been committed.
function placeWindow(window, geometry, area) {
    if (!window || window.deleted || window.move || window.resize)
        return;

    if (isMaximized(window)) {
        // KWin ignores geometry changes while the window is maximized. The
        // restore is asynchronous; maximizedChanged schedules another pass once
        // it completed. Request it only once so the maximize animation can
        // finish instead of being restarted on every arrange pass.
        requestRestore(window);
        return;
    }

    const current = window.frameGeometry;
    const target = placementTarget(window, geometry, area);

    if (current.width > target.width + GEOMETRY_TOLERANCE ||
        current.height > target.height + GEOMETRY_TOLERANCE) {
        const widest = Math.max(current.width, target.width);
        const tallest = Math.max(current.height, target.height);
        const maxX = area.x + Math.max(0, area.width - Math.min(widest, area.width));
        const maxY = area.y + Math.max(0, area.height - Math.min(tallest, area.height));
        const safe = {
            x: Math.round(clamp(current.x, area.x, maxX)),
            y: Math.round(clamp(current.y, area.y, maxY)),
            width: target.width,
            height: target.height,
        };

        // The window is already at the intermediate size; the client has not
        // committed the final slot move yet, so leave it alone.
        if (!sameGeometry(current, safe)) {
            log("tile shrink " + describeWindow(window) +
                " current=" + formatGeometry(current) +
                " target=" + formatGeometry(safe) +
                " final=" + formatGeometry(target));
            window.frameGeometry = Qt.rect(safe.x, safe.y, safe.width, safe.height);
        }
        return;
    }

    if (sameGeometry(current, target))
        return;

    log("tile place " + describeWindow(window) +
        " current=" + formatGeometry(current) +
        " target=" + formatGeometry(target));
    window.frameGeometry = Qt.rect(target.x, target.y, target.width, target.height);
}

// Client-enforced minimum sizes. Layouts use them to avoid handing a window a
// slot it cannot shrink into, which would leave it overlapping its neighbours.
function minimumSizes(windows) {
    return windows.map((window) => {
        const size = window.minSize;

        return {
            window: window,
            width: size && size.width > 0 ? Math.ceil(size.width) : 1,
            height: size && size.height > 0 ? Math.ceil(size.height) : 1,
        };
    });
}

function layoutContext(workspace, config, order, output, windows, area) {
    return {
        windows: windows,
        area: area,
        defaults: config.defaults,
        state: runtimeLayoutState(output),
        pinned: pinnedWindows(windows, config.rules),
        minimums: minimumSizes(windows),
        snapLeft: snapLeftWindow,
        snapRight: snapRightWindow,
    };
}

function arrange(workspace, config, order) {
    const screens = workspace.screens || [];
    const allWindows = orderedWindows(workspace, order);

    for (let screenIndex = 0; screenIndex < screens.length; ++screenIndex) {
        const output = screens[screenIndex];
        const windows = tileableWindows(allWindows, workspace, output, config.rules);
        if (windows.length === 0)
            continue;

        const area = workspace.clientArea(clientAreaOption(workspace), output, workspace.currentDesktop);
        if (!area || area.width <= 0 || area.height <= 0)
            continue;

        const placements = config.layout.arrange(
            layoutContext(workspace, config, order, output, windows, area)
        );

        for (let i = 0; i < placements.length; ++i) {
            const placement = placements[i];
            if (!placement || !placement.window || !placement.geometry)
                continue;

            setTiledLayer(placement.window);
            placeWindow(placement.window, placement.geometry, area);

            const pending = pendingPlacementFor(placement.window);
            if (pending && pending.tiled)
                pending.target = placement.geometry;
        }
    }
}

// While the user drags a tiled window, the layout owns the neighbouring tiles.
// Convert the resized frame into runtime split state and re-arrange: placeWindow
// skips the window that is currently being resized, so the user keeps control
// while the other tiles give or take space.
function resizeTiledWindow(state, window) {
    if (!state || !window || window.deleted || !window.resize)
        return false;

    const config = state.config;
    if (shouldFloat(window, ruleFor(window, config.rules)))
        return false;

    if (typeof config.layout.resize !== "function")
        return false;

    const workspace = state.workspace;
    const windows = tileableWindows(
        orderedWindows(workspace, state.order),
        workspace,
        window.output,
        config.rules
    );

    if (windows.length < 2 || windows.indexOf(window) === -1)
        return false;

    const area = workspace.clientArea(
        clientAreaOption(workspace),
        window.output,
        workspace.currentDesktop
    );
    if (!area || area.width <= 0 || area.height <= 0)
        return false;

    const baseline = resizeGeometryFor(window);
    if (!baseline) {
        // Some clients emit the first geometry change before
        // moveResizedChanged. Use that frame as the baseline so later frames
        // still update the split.
        rememberResizeGeometry(window, runtimeLayoutState(window.output));
        return false;
    }

    const context = layoutContext(
        workspace,
        config,
        state.order,
        window.output,
        windows,
        area
    );
    context.window = window;
    context.geometry = window.frameGeometry;
    context.baseline = baseline;
    context.baselineState = resizeLayoutStateFor(window);

    const next = config.layout.resize(context);
    if (!next)
        return false;

    setRuntimeLayoutState(window.output, next);
    return true;
}

function listWindows(workspace) {
    if (typeof workspace.windowList === "function")
        return workspace.windowList();

    return workspace.stackingOrder || [];
}

// KWin's stacking order changes whenever a window gets focus, so it cannot be
// used as the tile order. Keep a stable list instead: existing windows retain
// their tile positions and new windows are appended to the stack.
function initialOrder(workspace) {
    const source = workspace.stackingOrder || listWindows(workspace) || [];
    const windows = [];

    // Topmost first. This keeps the previously focused/master window in the
    // master slot after a reload instead of promoting a newly opened window.
    for (let i = source.length - 1; i >= 0; --i)
        windows.push(source[i]);

    return windows;
}

function rememberWindow(order, window) {
    if (window && order.indexOf(window) === -1)
        order.push(window);
}

function forgetWindow(order, window) {
    const index = order.indexOf(window);
    if (index !== -1)
        order.splice(index, 1);
}

function orderedWindows(workspace, order) {
    const windows = (order || []).slice();
    const current = listWindows(workspace) || [];

    for (let i = 0; i < current.length; ++i) {
        const window = current[i];
        if (windows.indexOf(window) === -1)
            windows.push(window);
    }

    return windows;
}

let tilerState = null;

function isActive(state) {
    return Boolean(state && state.active);
}

// A reload can leave the previous declarative script connected to KWin's
// signals even though unloadScript() reported success. Deactivate that old
// instance explicitly; otherwise two tilers with different configs keep
// applying their layouts to the same windows and oscillate forever.
function revealAllPendingPlacements() {
    for (let i = pendingPlacements.length - 1; i >= 0; --i)
        revealPendingPlacement(pendingPlacements[i]);
}

function resetRuntimeState() {
    revealAllPendingPlacements();

    pendingPlacements.length = 0;
    forcedFloatingWindows.length = 0;
    forcedTiledWindows.length = 0;
    movingWindows.length = 0;
    resizeGeometries.length = 0;
    snapMaximizedWindows.length = 0;
    tiledLayerWindows.length = 0;
    restoreRequests.length = 0;
    floatingGeometries.length = 0;
    layoutStates.length = 0;

    snapLeftWindow = null;
    snapRightWindow = null;
    placementTimer = null;
}

function stop(state) {
    if (!state)
        return;

    // Do not leave a window hidden if the script is unloaded while a placement
    // is still pending. Only touch the module state belonging to this instance.
    if (tilerState === state) {
        revealAllPendingPlacements();
        pendingPlacements.length = 0;
    }

    state.active = false;
}

function start(api) {
    if (tilerState)
        tilerState.active = false;

    resetRuntimeState();

    const workspace = api.workspace;
    const config = parseConfig(rulesConfig(api));
    const order = initialOrder(workspace);
    const state = {
        workspace: workspace,
        config: config,
        order: order,
        schedule: null,
        active: true,
    };
    let scheduled = false;

    placementTimer = api.placementTimer;
    tilerState = state;

    log("loaded " +
        config.rules.length +
        " rule(s), " +
        config.keymaps.length +
        " keymap(s), layout=" +
        config.layout.summary(config.defaults) +
        ", windows=" +
        order.length);

    function schedule() {
        if (!isActive(state) || scheduled)
            return;

        scheduled = true;
        Qt.callLater(() => {
            scheduled = false;
            if (!isActive(state))
                return;
            arrange(workspace, config, order);
        });
    }

    state.schedule = schedule;

    function apply(window, created) {
        if (!isActive(state))
            return;

        // Remember the client's startup geometry before the tiler overwrites it
        // with a tile slot. This is the best available substitute for the
        // application's preferred size, which KWin does not expose to scripts.
        if (created)
            saveFloatingGeometry(window, window.frameGeometry);

        // Windows can already be minimized when the script loads, or a client
        // can request it before the window is mapped.
        preventTiledMinimize(window, config.rules);

        // Queue (and hide) before applying so the compositor never presents the
        // client's startup frame at its default geometry.
        if (created)
            queuePendingPlacement(window, config.rules, workspace);

        applyWindow(window, config.rules, workspace);

        // Keep the remembered geometry in sync with floating rules and with
        // windows that were already floating when the script loaded. Tiled
        // windows keep the geometry captured before their first tile.
        if (shouldFloat(window, ruleFor(window, config.rules)))
            saveFloatingGeometry(window, window.frameGeometry);

        if (created) {
            const rule = ruleFor(window, config.rules);
            log("window-added " + describeWindow(window) +
                " caption=\"" + (window.caption || "") + "\"" +
                " flags=" + describeWindowFlags(window) +
                " geometry=" + formatGeometry(window.frameGeometry) +
                " rule=" + (rule ? "matched" : "none") +
                " state=" + (shouldFloat(window, rule) ? "floating" : "tiled"));
            followWindow(window, config.rules, workspace);

            // Tiled windows are hidden until arrange() has placed them. This
            // runs after followWindow() so a window that switches desktops is
            // judged against the desktop it ends up on.
            if (!shouldFloat(window, rule))
                queueTilePlacement(window, workspace);
        }
        schedule();
    }

    function watch(window) {
        window.minimizedChanged.connect(() => {
            if (!isActive(state))
                return;
            preventTiledMinimize(window, config.rules);
            schedule();
        });
        window.fullScreenChanged.connect(() => {
            if (!isActive(state))
                return;
            // The fullscreen frame must not be overwritten by a rule placement
            // that is still within its startup grace period.
            cancelPendingPlacementForFullscreen(window);
            schedule();
        });
        window.outputChanged.connect(schedule);
        window.desktopsChanged.connect(schedule);
        window.activitiesChanged.connect(schedule);

        if (window.maximizedChanged) {
            window.maximizedChanged.connect(() => {
                if (!isActive(state))
                    return;
                settlePendingPlacement(window);

                // Ignore the intermediate states emitted while the maximize
                // effect animates. Only the restored state needs a new arrange.
                if (isMaximized(window))
                    return;

                clearRestoreRequest(window);
                schedule();
            });
        }

        // Dropping a window on the top-edge snap zone asks KWin to maximize
        // before it emits the move-finished signal. Remember that request: on
        // Wayland the committed maximize state may still be pending when the
        // move ends.
        if (window.maximizedAboutToChange) {
            window.maximizedAboutToChange.connect((mode) => {
                if (!isActive(state))
                    return;
                if (!mode)
                    return;
                if (movingWindows.indexOf(window) === -1)
                    return;

                rememberWindow(snapMaximizedWindows, window);
            });
        }

        if (window.readyForPaintingChanged) {
            window.readyForPaintingChanged.connect(() => {
                if (!isActive(state))
                    return;
                settlePendingPlacement(window);
                schedule();
            });
        }

        // Some clients (e.g. WezTerm) resize themselves after they are mapped,
        // overwriting the tile geometry. Re-arrange once the window settles.
        // This also completes the shrink-then-move placement sequence.
        window.frameGeometryChanged.connect(() => {
            if (!isActive(state) || window.deleted)
                return;

            if (window.move || window.resize) {
                // Interactive move/resize wins over the initial rule geometry.
                forgetPendingPlacement(
                    window,
                    window.move ? "interactive-move" : "interactive-resize"
                );

                if (window.resize && !window.move &&
                    resizeTiledWindow(state, window))
                    schedule();
                return;
            }

            if (settlePendingPlacement(window))
                return;

            schedule();
        });

        window.moveResizedChanged.connect(() => {
            if (!isActive(state))
                return;

            if (window.move || window.resize) {
                forgetPendingPlacement(
                    window,
                    window.move ? "interactive-move" : "interactive-resize"
                );

                if (window.resize && !window.move) {
                    rememberResizeGeometry(
                        window,
                        runtimeLayoutState(window.output)
                    );
                }
            }

            if (window.move) {
                forgetResizeGeometry(window);

                if (movingWindows.indexOf(window) === -1) {
                    rememberWindow(movingWindows, window);
                    beginWindowMove(window, config.rules, workspace);
                    schedule();
                }
                return;
            }

            // Keep the window under the cursor for the whole resize. The other
            // tiles reflow on each frame; the final arrange below snaps the
            // resized window into the split it produced.
            if (window.resize)
                return;

            finishWindowMove(window, config.rules, workspace);
            forgetResizeGeometry(window);
            schedule();
        });
    }

    listWindows(workspace).forEach((window) => {
        rememberWindow(order, window);
        watch(window);
        Qt.callLater(() => apply(window));
    });

    workspace.windowAdded.connect((window) => {
        if (!isActive(state))
            return;

        rememberWindow(order, window);
        watch(window);

        // windowAdded is emitted from the client's first commit handler, before
        // the compositor paints that frame. Applying here (instead of deferring)
        // lets the hide in queuePendingPlacement take effect before the large
        // startup frame would become visible.
        apply(window, true);
    });
    workspace.windowRemoved.connect((window) => {
        if (!isActive(state))
            return;

        log("window-removed " + describeWindow(window) +
            " caption=\"" + (window.caption || "") + "\"" +
            " flags=" + describeWindowFlags(window));
        forgetWindow(order, window);
        forgetWindow(forcedFloatingWindows, window);
        forgetWindow(forcedTiledWindows, window);
        forgetWindow(movingWindows, window);
        forgetResizeGeometry(window);
        forgetWindow(snapMaximizedWindows, window);
        forgetWindow(restoreRequests, window);
        forgetWindow(tiledLayerWindows, window);
        forgetFloatingGeometry(window);
        if (snapLeftWindow === window)
            snapLeftWindow = null;
        if (snapRightWindow === window)
            snapRightWindow = null;
        forgetPendingPlacement(window, "window-removed");
        schedule();
    });
    workspace.currentDesktopChanged.connect(schedule);
    workspace.currentActivityChanged.connect(schedule);
    workspace.screensChanged.connect(schedule);
    workspace.virtualScreenGeometryChanged.connect(schedule);

    schedule();
    return state;
}

// Shortcut entry point. The declarative entry point wires this to a
// ShortcutHandler so the tiler itself does not depend on the shortcut API.
function activeWindow() {
    if (!isActive(tilerState))
        return null;

    return tilerState.workspace.activeWindow || null;
}

function toggleActiveWindow() {
    const window = activeWindow();
    if (!window)
        return;

    toggleFloating(window, tilerState.config.rules, tilerState.workspace);
    tilerState.schedule();
}

// Directional focus works on the windows' visible geometry, so it follows the
// actual layout regardless of which layout module arranged it. Popups, windows
// on other outputs or desktops, and minimized windows cannot be focused.
function focusCandidates(workspace, active) {
    return listWindows(workspace).filter((window) => {
        if (!window || window.deleted || window.minimized)
            return false;
        if (window === active)
            return false;
        if (typeof window.normalWindow === "boolean" && !window.normalWindow)
            return false;
        if (isPopupWindow(window))
            return false;
        if (!sameOutput(window, active.output))
            return false;
        if (!isOnCurrentDesktop(window, workspace) || !isOnCurrentActivity(window, workspace))
            return false;

        const geometry = window.frameGeometry;
        return geometry && geometry.width > 0 && geometry.height > 0;
    });
}

// A candidate lies in a direction when it is entirely on that side of the
// active window's frame. Overlapping windows are not considered: pressing a
// direction at a window sitting on top of another must not focus the hidden
// one. The primary distance is measured between the facing edges; the
// perpendicular center distance breaks ties between equally close candidates.
function focusMetrics(active, candidate, direction) {
    const source = active.frameGeometry;
    const target = candidate.frameGeometry;
    let primary;
    let secondary;

    switch (direction) {
    case "left":
        if (target.x + target.width > source.x + GEOMETRY_TOLERANCE)
            return null;
        primary = source.x - (target.x + target.width);
        secondary = Math.abs(
            (target.y + target.height / 2) - (source.y + source.height / 2)
        );
        break;
    case "right":
        if (target.x < source.x + source.width - GEOMETRY_TOLERANCE)
            return null;
        primary = target.x - (source.x + source.width);
        secondary = Math.abs(
            (target.y + target.height / 2) - (source.y + source.height / 2)
        );
        break;
    case "up":
        if (target.y + target.height > source.y + GEOMETRY_TOLERANCE)
            return null;
        primary = source.y - (target.y + target.height);
        secondary = Math.abs(
            (target.x + target.width / 2) - (source.x + source.width / 2)
        );
        break;
    case "down":
        if (target.y < source.y + source.height - GEOMETRY_TOLERANCE)
            return null;
        primary = target.y - (source.y + source.height);
        secondary = Math.abs(
            (target.x + target.width / 2) - (source.x + source.width / 2)
        );
        break;
    default:
        return null;
    }

    return {
        primary: Math.max(0, primary),
        secondary: secondary,
    };
}

function focusWindow(window, state, direction) {
    const candidates = focusCandidates(state.workspace, window);
    let best = null;
    let bestMetrics = null;

    for (let i = 0; i < candidates.length; ++i) {
        const metrics = focusMetrics(window, candidates[i], direction);
        if (!metrics)
            continue;

        if (!bestMetrics ||
            metrics.primary < bestMetrics.primary - GEOMETRY_TOLERANCE ||
            (Math.abs(metrics.primary - bestMetrics.primary) <= GEOMETRY_TOLERANCE &&
                metrics.secondary < bestMetrics.secondary)) {
            best = candidates[i];
            bestMetrics = metrics;
        }
    }

    if (best)
        state.workspace.activeWindow = best;
}

function focusActiveWindow(direction) {
    const window = activeWindow();
    if (!window || window.deleted)
        return;

    focusWindow(window, tilerState, direction);
}

// KWin's quick-tile shortcuts are geometry based. The keymap movement below
// works on the windows' visible order instead, so the master-stack layout can
// interpret Meta+Left/Right as "swap with the previous/next tile".
function visualOrder(windows) {
    return windows.slice().sort((a, b) => {
        const first = a.frameGeometry;
        const second = b.frameGeometry;

        if (Math.abs(first.x - second.x) > GEOMETRY_TOLERANCE)
            return first.x - second.x;
        if (Math.abs(first.y - second.y) > GEOMETRY_TOLERANCE)
            return first.y - second.y;

        return 0;
    });
}

// Replace the slots occupied by the visible windows with their new order while
// preserving the relative order of windows on other outputs or desktops.
function writeVisualOrder(order, windows, visual) {
    for (let i = 0; i < windows.length; ++i) {
        if (order.indexOf(windows[i]) === -1)
            order.push(windows[i]);
    }

    const positions = [];
    for (let i = 0; i < order.length; ++i) {
        if (windows.indexOf(order[i]) !== -1)
            positions.push(i);
    }

    for (let i = 0; i < positions.length; ++i)
        order[positions[i]] = visual[i];
}

function tileWindow(window, state, direction, others, visual) {
    saveFloatingGeometry(window, window.frameGeometry);
    setFloatOverride(window, false);

    if (direction < 0) {
        // Match a left snap: the window becomes master.
        snapLeftWindow = window;
        if (snapRightWindow === window)
            snapRightWindow = null;
    } else {
        // Match a right snap: the window joins the top of the stack.
        snapRightWindow = window;
        if (snapLeftWindow === window)
            snapLeftWindow = null;
    }

    writeVisualOrder(state.order, [window].concat(others), visual);
    applyWindow(window, state.config.rules, state.workspace);
    state.schedule();
}

function moveWindow(window, state, direction) {
    const tiled = tileableWindows(
        orderedWindows(state.workspace, state.order),
        state.workspace,
        window.output,
        state.config.rules
    );

    if (shouldFloat(window, ruleFor(window, state.config.rules))) {
        const others = visualOrder(tiled);

        if (direction < 0) {
            tileWindow(window, state, direction, others, [window].concat(others));
            return;
        }

        const visual = others.length > 0
            ? [others[0], window].concat(others.slice(1))
            : [window];
        tileWindow(window, state, direction, others, visual);
        return;
    }

    const windows = visualOrder(tiled);
    const index = windows.indexOf(window);
    if (index === -1)
        return;

    const target = index + direction;
    if (target < 0 || target >= windows.length)
        return;

    const visual = windows.slice();
    visual[index] = windows[target];
    visual[target] = windows[index];

    // Snap hints describe the old order. Replace them with the explicit visual
    // order, and keep the new master primary even when pinned rules exist.
    snapLeftWindow = visual[0];
    snapRightWindow = null;
    writeVisualOrder(state.order, windows, visual);
    state.schedule();
}

function moveActiveWindow(direction) {
    const window = activeWindow();
    if (!window || window.deleted || window.fullScreen || window.minimized)
        return;

    moveWindow(window, tilerState, direction);
}

// Execute a keymaps[].action from config.json. The action identifiers are
// validated by script/rules.qml against contents/code/actions.js.
function runAction(action) {
    const window = activeWindow();
    if (!window)
        return;

    switch (action) {
    case "close-window":
        window.closeWindow();
        return;
    case "focus-left":
        focusActiveWindow("left");
        return;
    case "focus-right":
        focusActiveWindow("right");
        return;
    case "focus-up":
        focusActiveWindow("up");
        return;
    case "focus-down":
        focusActiveWindow("down");
        return;
    case "move-window-left":
        moveActiveWindow(-1);
        return;
    case "move-window-right":
        moveActiveWindow(1);
        return;
    case "toggle-floating":
        toggleActiveWindow();
        return;
    case "toggle-fullscreen":
        window.fullScreen = !window.fullScreen;
        return;
    default:
        logError("unknown action: " + action);
    }
}

// The QML entry point calls start() from ui/main.qml.

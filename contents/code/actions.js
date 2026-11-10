.pragma library

// Key action registry
//
// Keymaps in config.json reference one of these action identifiers. Keeping the
// registry in one module lets the config validator and the tiler agree on the
// supported actions without duplicating the list. The tiler executes them in
// tiler.js.
//
// Action module interface
// -----------------------
// Each action exports:
//
//   id: string
//       Stable identifier used in config.json as keymaps[].action.
//
//   label: string
//       Human-readable name used for the ShortcutHandler description.

const actions = [
    { id: "close-window", label: "Close window" },
    { id: "focus-left", label: "Focus window left" },
    { id: "focus-right", label: "Focus window right" },
    { id: "focus-up", label: "Focus window up" },
    { id: "focus-down", label: "Focus window down" },
    { id: "move-window-left", label: "Move window left" },
    { id: "move-window-right", label: "Move window right" },
    { id: "toggle-floating", label: "Toggle floating" },
    { id: "toggle-fullscreen", label: "Toggle fullscreen" },
];

// Keymaps are only registered when config.json contains them. An absent or
// empty keymaps array disables all keymaps.
const modifierOrder = ["Meta", "Ctrl", "Alt", "Shift"];

const modifiers = {
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    cmd: "Meta",
    command: "Meta",
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
};

// Qt key sequence names that differ from their common spelling in config.json.
const keyAliases = {
    backspace: "Backspace",
    tab: "Tab",
    enter: "Return",
    return: "Return",
    escape: "Esc",
    esc: "Esc",
    space: "Space",
    pageup: "PgUp",
    "page-up": "PgUp",
    pgup: "PgUp",
    pagedown: "PgDown",
    "page-down": "PgDown",
    pgdown: "PgDown",
    home: "Home",
    end: "End",
    insert: "Ins",
    ins: "Ins",
    delete: "Del",
    del: "Del",
    left: "Left",
    right: "Right",
    up: "Up",
    down: "Down",
    print: "Print",
    pause: "Pause",
    menu: "Menu",
    capslock: "CapsLock",
    numlock: "NumLock",
    scrolllock: "ScrollLock",
    plus: "+",
    minus: "-",
    comma: ",",
    period: ".",
    slash: "/",
    backslash: "\\",
    semicolon: ";",
    apostrophe: "'",
    grave: "`",
};

// KGlobalAccel modifier bits (Qt::KeyboardModifier) and Qt key codes. They let
// setup find and clear conflicting global shortcuts for configured keymaps.
const modifierBits = {
    Meta: 0x10000000,
    Ctrl: 0x04000000,
    Alt: 0x08000000,
    Shift: 0x02000000,
};

const keyCodes = {
    Backspace: 0x01000003,
    Tab: 0x01000001,
    Return: 0x01000004,
    Esc: 0x01000000,
    Space: 0x20,
    PgUp: 0x01000016,
    PgDown: 0x01000017,
    Home: 0x01000010,
    End: 0x01000011,
    Ins: 0x01000006,
    Del: 0x01000007,
    Left: 0x01000012,
    Up: 0x01000013,
    Right: 0x01000014,
    Down: 0x01000015,
    Print: 0x01000009,
    Pause: 0x01000008,
    Menu: 0x01000055,
    CapsLock: 0x01000024,
    NumLock: 0x01000025,
    ScrollLock: 0x01000026,
};

function ids() {
    return actions.map((action) => action.id);
}

function find(id) {
    for (let i = 0; i < actions.length; ++i) {
        if (actions[i].id === id)
            return actions[i];
    }

    return null;
}

function label(id) {
    const action = find(id);
    return action ? action.label : String(id);
}

function normalizeKey(value, label) {
    const token = value.trim();
    if (token.length === 0)
        throw new Error(label + ".mapping must contain non-empty key names");

    const lower = token.toLowerCase();

    if (Object.prototype.hasOwnProperty.call(keyAliases, lower))
        return keyAliases[lower];
    if (token.length === 1)
        return token.toUpperCase();
    if (/^f([1-9]|[12][0-9]|3[0-5])$/.test(lower))
        return "F" + lower.slice(1);

    // Unknown names are passed through with a leading capital so Qt's key
    // sequence parser sees a key name rather than a lowercase token.
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function keyCodeFor(key) {
    if (Object.prototype.hasOwnProperty.call(keyCodes, key))
        return keyCodes[key];
    if (key.length === 1)
        return key.charCodeAt(0);

    const functionKey = /^F([1-9]|[12][0-9]|3[0-5])$/.exec(key);
    if (functionKey)
        return 0x01000030 + Number(functionKey[1]) - 1;

    return null;
}

function normalizeMapping(value, label) {
    if (!Array.isArray(value))
        throw new Error(label + ".mapping must be an array of key names");
    if (value.length === 0)
        throw new Error(label + ".mapping must contain a key");

    const seen = {};
    let key = null;

    for (let i = 0; i < value.length; ++i) {
        if (typeof value[i] !== "string")
            throw new Error(label + ".mapping must contain strings");

        const token = value[i].trim();
        if (token.length === 0)
            throw new Error(label + ".mapping must contain non-empty key names");

        const modifier = modifiers[token.toLowerCase()];
        if (modifier !== undefined) {
            if (seen[modifier])
                throw new Error(label + ".mapping contains " + modifier + " more than once");
            seen[modifier] = true;
            continue;
        }

        if (key !== null)
            throw new Error(label + ".mapping must contain exactly one non-modifier key");
        key = normalizeKey(token, label);
    }

    if (key === null)
        throw new Error(label + ".mapping must contain a non-modifier key");

    const code = keyCodeFor(key);
    if (code === null)
        throw new Error(label + ".mapping uses an unsupported key: " + key);

    const parts = [];
    let keyCode = code;
    for (let i = 0; i < modifierOrder.length; ++i) {
        const modifier = modifierOrder[i];
        if (seen[modifier]) {
            parts.push(modifier);
            keyCode |= modifierBits[modifier];
        }
    }
    parts.push(key);

    return { sequence: parts.join("+"), keyCode: keyCode };
}

function normalizeKeymap(value, index) {
    const label = "keymaps[" + index + "]";

    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(label + " must be a mapping");
    if (typeof value.action !== "string" || value.action.length === 0)
        throw new Error(label + ".action must be a non-empty string");

    const action = find(value.action);
    if (!action)
        throw new Error(label + ".action must be one of: " + ids().join(", "));

    let sequence;
    let keyCode = null;
    if (value.mapping !== undefined) {
        const mapping = normalizeMapping(value.mapping, label);
        sequence = mapping.sequence;
        keyCode = mapping.keyCode;
    } else if (value.sequence !== undefined) {
        // The normalized form written to kwinrc keeps the resolved sequence.
        if (typeof value.sequence !== "string" || value.sequence.length === 0)
            throw new Error(label + ".sequence must be a non-empty string");
        sequence = value.sequence;
        if (typeof value.keyCode === "number")
            keyCode = value.keyCode;
    } else {
        throw new Error(label + " must contain mapping");
    }

    return {
        action: action.id,
        label: action.label,
        sequence: sequence,
        keyCode: keyCode,
    };
}

function normalizeKeymaps(value) {
    if (value === undefined || value === null)
        value = [];
    if (!Array.isArray(value))
        throw new Error("keymaps must be an array");

    const result = [];
    const actionsSeen = {};
    const sequencesSeen = {};

    for (let i = 0; i < value.length; ++i) {
        const keymap = normalizeKeymap(value[i], i);

        if (actionsSeen[keymap.action])
            throw new Error("keymaps[" + i + "].action duplicates " + keymap.action);
        actionsSeen[keymap.action] = true;

        if (sequencesSeen[keymap.sequence])
            throw new Error("keymaps[" + i + "].mapping duplicates " + keymap.sequence);
        sequencesSeen[keymap.sequence] = true;

        result.push(keymap);
    }

    return result;
}

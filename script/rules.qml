import QtQml
import "../contents/code/actions.js" as Actions
import "../contents/code/layout.js" as Layout

QtObject {
    function fail(message) {
        throw new Error(message);
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function dimension(value, defaultUnit, label, size) {
        let number;
        let unit;

        if (typeof value === "number") {
            number = value;
            unit = defaultUnit;
        } else if (typeof value === "string") {
            const match = value.match(/^(-?[0-9]+(?:\.[0-9]+)?)(px|%)$/);
            if (!match)
                fail(label + " must be a number or a string ending in % or px");
            number = Number(match[1]);
            unit = match[2];
        } else {
            fail(label + " must be a number or a string ending in % or px");
        }

        if (!isFinite(number))
            fail(label + " must be finite");

        if (size) {
            if (unit === "%") {
                if (number < 1 || number > 100)
                    fail(label + " must be between 1% and 100%");
            } else if (number < 1 || number > 32767) {
                fail(label + " must be between 1px and 32767px");
            }
        }

        return { value: number, unit: unit };
    }

    function normalizePosition(value) {
        if (value === undefined || value === null)
            return null;
        if (!isObject(value))
            fail("position must be a mapping");
        if (value.left == null && value.top == null)
            return null;

        return {
            left: value.left == null ? null : dimension(value.left, "px", "position.left", false),
            top: value.top == null ? null : dimension(value.top, "px", "position.top", false),
        };
    }

    function normalizeSize(value) {
        if (value === undefined || value === null)
            return null;
        if (!isObject(value))
            fail("size must be a mapping");
        if (value.width == null && value.height == null)
            return null;

        return {
            width: value.width == null ? null : dimension(value.width, "%", "size.width", true),
            height: value.height == null ? null : dimension(value.height, "%", "size.height", true),
        };
    }

    function normalizeMatch(value) {
        if (!isObject(value))
            fail("match must be a mapping");
        if (value.class === undefined && value.title === undefined)
            fail("match must contain class or title");

        const result = {};

        if (value.class !== undefined) {
            let classes;

            if (typeof value.class === "string")
                classes = [value.class];
            else if (Array.isArray(value.class))
                classes = value.class.slice();
            else
                fail("match.class must be a string or an array of strings");

            if (classes.length === 0)
                fail("match.class must contain non-empty strings");
            for (let i = 0; i < classes.length; ++i) {
                if (typeof classes[i] !== "string" || classes[i].length === 0)
                    fail("match.class must contain non-empty strings");
            }

            result.class = classes;
        }

        if (value.title !== undefined) {
            if (typeof value.title !== "string" || value.title.length === 0)
                fail("match.title must be a non-empty string");
            result.title = value.title;
        }

        return result;
    }

    function normalizeDefaults(value) {
        if (value === undefined || value === null)
            value = {};
        if (!isObject(value))
            fail("defaults must be a mapping");

        const layoutId = value.layout === undefined ? Layout.defaultId() : value.layout;
        if (typeof layoutId !== "string" || !Layout.find(layoutId))
            fail("defaults.layout must be one of: " + Layout.ids().join(", "));

        const options = {};
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; ++i) {
            if (keys[i] !== "layout")
                options[keys[i]] = value[keys[i]];
        }

        const normalized = Layout.normalizeDefaults(layoutId, options);
        const result = { layout: layoutId };
        const optionKeys = Object.keys(normalized);
        for (let i = 0; i < optionKeys.length; ++i)
            result[optionKeys[i]] = normalized[optionKeys[i]];

        return result;
    }

    function normalizeRule(value, index) {
        const label = "rules[" + index + "]";

        if (!isObject(value))
            fail(label + " must be a mapping");
        if (value.match === undefined)
            fail(label + " must contain match");

        const match = normalizeMatch(value.match);
        // Keep an omitted float undefined so the tiler can distinguish "use
        // the window's default" from an explicit float:false.
        const float = value.float;
        if (float !== undefined && typeof float !== "boolean")
            fail(label + ".float must be a boolean");

        const follow = value.follow === undefined ? false : value.follow;
        if (typeof follow !== "boolean")
            fail(label + ".follow must be a boolean");

        const desktop = value.desktop === undefined ? null : value.desktop;
        if (desktop !== null && desktop !== "all") {
            if (typeof desktop !== "number" || !isFinite(desktop) ||
                Math.floor(desktop) !== desktop || desktop < 1)
                fail(label + ".desktop must be a positive integer or \"all\"");
        }

        const layer = value.layer === undefined ? null : value.layer;
        if (layer !== null && layer !== "above" && layer !== "below")
            fail(label + ".layer must be \"above\" or \"below\"");

        const position = normalizePosition(value.position);
        const size = normalizeSize(value.size);

        if ((position !== null || size !== null || layer !== null) && float !== true)
            fail(label + ": floating actions require float: true");

        return {
            match: match,
            float: float,
            follow: follow,
            desktop: desktop,
            layer: layer,
            position: position,
            size: size,
        };
    }

    function normalizeConfig(configValue, rulesValue) {
        if (!isObject(configValue))
            fail("config must be a mapping");
        if (!isObject(rulesValue))
            fail("rules must be a mapping");

        const desktops = configValue.desktops === undefined ? 10 : configValue.desktops;
        if (typeof desktops !== "number" || !isFinite(desktops) ||
            Math.floor(desktops) !== desktops || desktops < 1 || desktops > 10)
            fail("desktops must be an integer between 1 and 10");

        const defaultsInput = {};
        const configKeys = Object.keys(configValue);
        for (let i = 0; i < configKeys.length; ++i) {
            const key = configKeys[i];
            if (key !== "desktops" && key !== "keymaps")
                defaultsInput[key] = configValue[key];
        }

        if (!Object.prototype.hasOwnProperty.call(rulesValue, "rules"))
            fail("rules must contain rules");
        if (!Array.isArray(rulesValue.rules))
            fail("rules must be an array");

        return {
            desktops: desktops,
            defaults: normalizeDefaults(defaultsInput),
            keymaps: Actions.normalizeKeymaps(configValue.keymaps),
            rules: rulesValue.rules.map(normalizeRule),
        };
    }

    function formatDimension(value) {
        if (value == null)
            return "-";
        return value.value + (value.unit === "%" ? "%" : "px");
    }

    function formatMatch(match) {
        const parts = [];
        if (match.class)
            parts.push("class=" + match.class.join(","));
        if (match.title)
            parts.push("title=" + match.title);
        return parts.join(" ");
    }

    function formatRow(rule) {
        return [
            formatMatch(rule.match),
            rule.float == null ? "-" : String(rule.float),
            String(rule.follow),
            rule.desktop == null ? "-" : String(rule.desktop),
            rule.position == null
                ? "-"
                : formatDimension(rule.position.left) + "," + formatDimension(rule.position.top),
            rule.size == null
                ? "-"
                : formatDimension(rule.size.width) + "," + formatDimension(rule.size.height),
            rule.layer == null ? "-" : rule.layer,
        ];
    }

    function formatTable(config) {
        const header = ["MATCH", "FLOAT", "FOLLOW", "DESKTOP", "POSITION", "SIZE", "LAYER"];
        const rows = [header];
        for (let i = 0; i < config.rules.length; ++i)
            rows.push(formatRow(config.rules[i]));

        const widths = [];
        for (let column = 0; column < header.length; ++column) {
            let width = 0;
            for (let row = 0; row < rows.length; ++row)
                width = Math.max(width, rows[row][column].length);
            widths.push(width);
        }

        const lines = [
            "Desktops: " + config.desktops,
            "Rules: " + config.rules.length,
            "Layout: " + Layout.summary(config.defaults.layout, config.defaults),
        ];

        for (let row = 0; row < rows.length; ++row) {
            const cells = [];
            for (let column = 0; column < header.length; ++column)
                cells.push(rows[row][column].padEnd(widths[column]));
            lines.push(cells.join("  ").replace(/\s+$/, ""));
        }

        lines.push("Keymaps: " + config.keymaps.length);
        for (let i = 0; i < config.keymaps.length; ++i) {
            lines.push("  " + config.keymaps[i].sequence + "  " + config.keymaps[i].label);
        }

        return lines.join("\n");
    }

    function applicationArguments() {
        const args = Qt.application.arguments;
        const separator = args.indexOf("--");
        return separator === -1 ? args : args.slice(separator + 1);
    }

    Component.onCompleted: {
        try {
            const args = applicationArguments();
            if (args.length < 3)
                fail("usage: rules.qml -- <json|settings|table> <config-json> <rules-json>");

            const mode = String(args[0]);
            const config = normalizeConfig(
                JSON.parse(String(args[1])),
                JSON.parse(String(args[2])));

            if (mode === "json") {
                print(JSON.stringify({
                    defaults: config.defaults,
                    keymaps: config.keymaps,
                    rules: config.rules,
                }));
            } else if (mode === "settings") {
                print("desktops=" + config.desktops);
            } else if (mode === "keymaps") {
                for (let i = 0; i < config.keymaps.length; ++i) {
                    const keymap = config.keymaps[i];
                    if (keymap.keyCode == null)
                        fail("keymaps[" + i + "]: cannot resolve key code for " + keymap.sequence);
                    print(keymap.keyCode + "\t" + "Kazulejo: " + keymap.label +
                        "\t" + keymap.label + " (" + keymap.sequence + ")");
                }
            } else if (mode === "table") {
                print(formatTable(config));
            } else {
                fail("unknown mode: " + mode);
            }

            Qt.exit(0);
        } catch (error) {
            print("error: " + error.message);
            Qt.exit(1);
        }
    }
}

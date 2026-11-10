# kazulejo

A tiling window manager for KDE Plasma 6 which doesn't suck.

Kazulejo is a KWin script. It applies class-based window rules and tiles unmatched normal windows with a configurable
layout. The built-in `master-stack` layout fills the work area with one tiled window and splits the remaining space
between a master column and a stack.
Dialogs, utilities, transients, and popups float automatically.

The repository executable is `setup`, run as `./setup`. The AUR package installs the same script as `kazulejo`. It
handles first-time setup and rule application; there are no subcommands.

Every invocation previews by default, pass `--apply` when you want changes.

## WARNING

This project is under active development. Use it at your own risk.

Kazulejo changes KWin, panel, desktop-effect, shortcut, and autostart settings. Try it under a new user account first:
create the account, log in, and run the setup there. That lets you evaluate Kazulejo without changing your main
desktop configuration.

## Requirements

- KDE Plasma 6 / KWin 6
- `argc` (installed automatically on first run; see below)
- KDE CLI tools: `kreadconfig6`, `kwriteconfig6`, `qdbus6`
- `busctl` for desktop properties and KGlobalAccel array calls
- `diff` for installed package comparison
- `xkbcli` for reading the active keyboard layout
- Qt QML runtime: `qml` or `qml6`
- `curl`, `tar`, and `sha256sum` for the automatic argc install

## The argc dependency

The script uses [argc](https://github.com/sigoden/argc) to parse its command line. If `argc` is not on `PATH`, the
script downloads a pinned release into `${XDG_DATA_HOME:-$HOME/.local/share}/kazulejo/bin/argc` on first run. The
archive is verified against a built-in SHA-256 checksum before it is executed, and no root access is needed.

The automatic install can be disabled:

```sh
KAZULEJO_NO_AUTOFETCH=1 ./setup
```

To use a specific binary, point `KAZULEJO_ARGC` at it:

```sh
KAZULEJO_ARGC=/path/to/argc ./setup
```

## Arch Linux (AUR)

Install `kazulejo-git` from the AUR. The package installs the script and its resources under `/usr/lib/kazulejo` and
links `/usr/bin/kazulejo`.

After installing or upgrading the package, run:

```sh
kazulejo --apply
```

Package upgrades update `/usr/lib/kazulejo`, but the per-user copy in `~/.local/share/kwin/scripts/kazulejo` is
refreshed by the login autostart. To apply an upgrade immediately without logging out, run `kazulejo --apply`.

Cloning the repository and running `./setup --apply` still works the same way.

## First-time setup

Run from the repository root:

```sh
./setup --apply
```

This is idempotent and safe to re-run. It:

- creates `~/.config/kazulejo/config.json` and `rules.json` from the bundled examples if missing
- copies the KWin package into `~/.local/share/kwin/scripts/kazulejo`
- enables the script
- installs `~/.config/autostart/kazulejo.desktop`
- ensures the configured number of virtual desktops in one row
- uses a fade instead of a slide animation when switching desktops
- configures an existing pager to show desktop numbers and window icons
- configures the task manager to show tasks from all desktops without grouping
- disables the task switcher's "Show selected window" option so only the preview grid is shown
- binds `Meta+1..0` to switch desktops and `Meta+Shift+1..0` to move windows
- applies the rules and keymaps and reloads KWin when it is running

The KWin package is copied, so re-run `./setup --apply` after changing the repository.

Preview every change by omitting `--apply`:

```sh
./setup
```

If KWin is not running, the package, config, autostart entry, and panel settings are still installed. Log in to Plasma
and run `./setup --apply` again to finish the desktop and shortcut setup.

## Config files

`~/.config/kazulejo/config.json` holds the tiler defaults and session settings:

```json
{
  "desktops": 10,
  "layout": "master-stack",
  "masterRatio": 0.6,
  "gap": 4,
  "keymaps": [
    {"action": "focus-left", "mapping": ["meta", "h"]},
    {"action": "focus-right", "mapping": ["meta", "l"]},
    {"action": "focus-up", "mapping": ["meta", "k"]},
    {"action": "focus-down", "mapping": ["meta", "j"]},
    {"action": "move-window-left", "mapping": ["meta", "left"]},
    {"action": "move-window-right", "mapping": ["meta", "right"]},
    {"action": "toggle-fullscreen", "mapping": ["meta", "up"]},
    {"action": "toggle-floating", "mapping": ["meta", "down"]}
  ]
}
```

The bundled config uses `gap: 4`. If `gap` is omitted entirely, the selected layout's own default is used; for
`master-stack` that is `gap: 8`.

`~/.config/kazulejo/rules.json` holds only the window rules:

```json
{
  "rules": [
    {"match": {"class": "Main-Tmux"}, "desktop": 10}
  ]
}
```

## Editing rules

Edit `~/.config/kazulejo/rules.json` for window rules, and `~/.config/kazulejo/config.json` for desktops, layout
defaults, or keymaps.
Preview the result, then apply it:

```sh
./setup
./setup --apply
```

The autostart entry runs the script with `--apply --quiet` on each login, so edited rules are also applied automatically
after the next login.

The same command reports the config, installation state, desktops, task manager, and shortcuts in its preview.

The autostart entry uses `~/.config/kazulejo/config.json` and `rules.json`.

## Rules

A rule can match by exact window class (or a list of classes) and by a case-insensitive title substring. Rules with
`float: true` are evaluated first, in config order; if none match, the remaining rules are evaluated in order. The first
match wins. A matching rule tiles normal windows unless it sets `float: true`, so a floating rule takes priority over a
broader tiling rule even when it appears later in the file.

Windows that float by themselves - popups, transients, dialogs, utilities, and similar - stay floating even when a rule
matches. Only a rule that explicitly sets `"float": false` forces such a window into the tiling layout.

Rule fields are applied independently. If a rule omits `desktop`, `follow`, `layer`, or `size`, that property is left
unchanged. A rule that sets `size` but omits `position` centers the window in the work area at the configured size.
Position is likewise applied per axis: an axis without an explicit `left` or `top` value is centered. The geometry is
applied before the window is shown, so it does not first appear at the application's default size.

Tiled windows are placed on the below layer so floating windows stay above them.

When a rule sets `follow: true` and a specific `desktop`, a newly created window also switches the current virtual
desktop to that desktop. The switch only happens when the window is created; moving an existing window does not change
the current desktop. `follow` defaults to `false`.

This example shows the complete shape of `rules.json`. Layout defaults (`layout`, `gap`, `masterRatio`) and `keymaps`
belong in `config.json`, not in `rules.json`.

```json
{
  "rules": [
    {
      "match": {"class": "Main-Tmux"},
      "desktop": 10,
      "follow": true
    },
    {
      "match": {"class": "mpv"},
      "float": true,
      "layer": "above",
      "position": {"left": "75%", "top": "80%"},
      "size": {"width": "20%", "height": "15%"}
    }
  ]
}
```

`setup` validates and normalizes the config and rule files with the KDE/Qt JavaScript engine before writing them to
KWin. The normalized form is what the KWin script reads.

## Keymaps

`config.json` can bind window actions in addition to the desktop shortcuts managed by `setup`:

```json
{
  "keymaps": [
    {"action": "focus-left", "mapping": ["meta", "h"]},
    {"action": "focus-right", "mapping": ["meta", "l"]},
    {"action": "focus-up", "mapping": ["meta", "k"]},
    {"action": "focus-down", "mapping": ["meta", "j"]},
    {"action": "move-window-left", "mapping": ["meta", "left"]},
    {"action": "move-window-right", "mapping": ["meta", "right"]},
    {"action": "toggle-fullscreen", "mapping": ["meta", "up"]},
    {"action": "toggle-floating", "mapping": ["meta", "down"]},
    {"action": "close-window", "mapping": ["meta", "q"]}
  ]
}
```

Supported actions:

| Action | Effect |
| --- | --- |
| `close-window` | Close the active window |
| `focus-left` | Focus the nearest window to the left |
| `focus-right` | Focus the nearest window to the right |
| `focus-up` | Focus the nearest window above |
| `focus-down` | Focus the nearest window below |
| `move-window-left` | Swap the active window with the previous tile |
| `move-window-right` | Swap the active window with the next tile |
| `toggle-floating` | Toggle the active window between tiled and floating |
| `toggle-fullscreen` | Toggle fullscreen for the active window |

Directional focus uses the windows' visible geometry on the current output and desktop. A window is only a candidate
when it lies entirely in the requested direction, and the closest candidate wins. If there is no window on that side,
the action does nothing.

In the master-stack layout, moving left swaps the active window toward the master slot; the first stack window therefore
becomes master. Moving right swaps the master with the first stack window, or moves a stack window one slot down. On a
floating window, left tiles it as master and right tiles it as the first stack window.

`mapping` is an array of key names. Modifier names are case-insensitive and accept `meta`/`super`/`win`,
`ctrl`/`control`, `alt`/`option`, and `shift`; the remaining entry is the key, for example `["ctrl", "alt", "t"]`. Key
names such as `return`, `escape`, `space`, `left`, `page-up`, and `f1` are accepted.

Keymaps are only registered when they exist in `config.json`. Omit the `keymaps` key, or use an empty array, to disable
all keymaps. The bundled config binds `focus-left`/`focus-right`/`focus-up`/`focus-down` to
`Meta+H`/`Meta+L`/`Meta+K`/`Meta+J`, `move-window-left`/`move-window-right` to `Meta+Left`/`Meta+Right`,
`toggle-fullscreen` to `Meta+Up`, and `toggle-floating` to `Meta+Down`. Each action can appear only once, and two
keymaps cannot use the same sequence. `setup` removes those keys from KWin's conflicting built-in actions before
reloading the script, so a Kazulejo keymap takes priority over any KDE shortcut using the same combination.

After editing, run `./setup --apply`; the script normalizes the file, writes the shortcuts to KWin, and reloads it.

## Layouts

The layout is selected with the top-level `layout` key in `config.json` and defaults to `master-stack`. Each layout owns
both its options and its geometry calculation. The tiler only decides which windows are tiled and hands them to the
selected layout.

Layout modules live in `contents/code/layouts/` and implement the interface documented in `contents/code/layout.js`:

- `id` and `label`,
- `defaults()` and `normalizeDefaults(value)`,
- `summary(options)`,
- `arrange(context)`, returning one `{window, geometry}` entry per window,
- optional `resize(context)`, returning updated runtime split state or `null`.

`arrange` receives the layout's runtime `state`, if any. `resize` is called while a tiled window is dragged and may
return a new state; the tiler stores it per output and passes it back to `arrange`. The `resize` context adds `window`,
its current `geometry`, and the `baseline` geometry from the start of the drag.

The registry in `contents/code/layout.js` is shared by the tiler and the config validator. Adding a layout therefore
means adding one module, registering it in that file, and rerunning `./setup --apply`; its option keys are validated
without hardcoding them in `script/rules.qml`.

## Floating and tiling at runtime

Rules define the initial state, but windows can be switched at runtime:

- Drag a tiled window by its title bar to make it float. It returns to the geometry it had before it was tiled; if that
  was never seen (for example after a script reload), a default centered floating size is used. The remaining tiles
  rearrange immediately.
- Drag a floating window until KWin shows its snap marker (the gray preview rectangle) to tile it again. Merely touching
  a work-area edge is not enough. The snapped side selects the slot: a left snap takes the master column and a right
  snap takes the first stack slot beside the existing tiled window.
- Resizing a tiled window adjusts the layout split. Dragging the divider between the master and stack changes the master
  ratio; dragging a divider between stack rows changes their relative heights. The other tiles reflow while the drag is
  in progress, and the resized window snaps into the resulting slot when it finishes. Edges on the outside of the work
  area are ignored and snap back.
- Minimizing a tiled window is undone immediately: the window stays in its tile, and the remaining tiles do not reflow.
  Floating windows can still be minimized normally.
- The bundled keymaps focus the nearest window with `Meta+H`/`Meta+L`/`Meta+K`/ `Meta+J`, swap the active tile toward
  the master or the stack with `Meta+Left`/`Meta+Right`, toggle fullscreen with `Meta+Up`, and toggle the active window
  between tiled and floating with `Meta+Down`. Directional focus does nothing when no window lies in that direction.
  Floating windows tile as master with left and as the first stack window with right. Keymaps are only active when they
  are listed in `config.json`.

These runtime changes last until KWin reloads the script; they are not written back to `rules.json`.

## Virtual desktops

`./setup --apply` ensures the configured number of virtual desktops (default 10) in a single row, enables the Fade
effect and disables Slide for desktop switching, and binds:

| Shortcut | Action |
| --- | --- |
| `Meta+1..0` | switch to desktop 1..10 |
| `Meta+Shift+1..0` | move the current window to desktop 1..10 |

On Wayland, KWin reports `Shift`+digit as the shifted symbol (for example `Meta+!` for `Meta+Shift+1`). `setup`
therefore also binds the symbol form, using `xkbcli` to cover every keyboard layout in use.

If a pager widget is present, it updates every `org.kde.plasma.pager` widget to show desktop numbers
(`displayedText=Number`) and window icons (`showWindowIcons=true`); a missing pager is left alone. It also updates every
Icons-only or regular task manager widget to show tasks from all desktops (`showOnlyCurrentDesktop=false`) without
grouping (`groupingStrategy=0`). When Plasma is running, the changes are applied to the live panel immediately.

The task switcher is configured with `HighlightWindows=false` under both `[TabBox]` and `[TabBoxAlternative]`. This
disables **Show selected window**, so switching shows only the preview grid instead of revealing the selected window
over the background.

`./setup` shows the current state and planned changes without changing it.

## Removing

There is no uninstall command yet. To remove Kazulejo manually:

1. Remove the autostart entry:

   ```sh
   rm -f ~/.config/autostart/kazulejo.desktop
   ```

2. Remove the per-user KWin package:

   ```sh
   rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/kwin/scripts/kazulejo"
   ```

3. Remove the `kazulejoEnabled` key from `[Plugins]` and the `[Script-kazulejo]` group in `~/.config/kwinrc`, then
   reconfigure KWin:

   ```sh
   qdbus6 org.kde.KWin /KWin org.kde.KWin.reconfigure
   ```

4. Remove `~/.config/kazulejo` if you no longer need your configuration.
5. Revert the panel, task-switcher, and desktop-animation settings that `setup` changed, and remove the `Meta+1..0`,
   `Meta+Shift+1..0`, and Kazulejo action shortcuts in **System Settings > Shortcuts**.
6. If installed from the AUR, remove the package with `pacman -R kazulejo-git`.

The values `setup` applies for the panel, task switcher, and desktop animation are listed in
[Virtual desktops](#virtual-desktops).

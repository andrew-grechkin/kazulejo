.pragma library

// Master-stack layout
//
// One master window on the left, the remaining windows stacked vertically on
// the right. A single tiled window fills the whole work area.
//
// This file implements the layout interface documented in ../layout.js. It
// must not touch KWin objects; it only turns an area and a window order into
// geometries, which keeps it usable by both the tiler and the config
// validator.

const id = "master-stack";
const label = "Master stack";

function defaults() {
    return {
        masterRatio: 0.6,
        gap: 8,
    };
}

function normalizeDefaults(value) {
    const masterRatio = value.masterRatio === undefined ? 0.6 : value.masterRatio;
    if (typeof masterRatio !== "number" || !isFinite(masterRatio))
        throw new Error("defaults.masterRatio must be a number");
    if (masterRatio < 0.1 || masterRatio > 0.9)
        throw new Error("defaults.masterRatio must be between 0.1 and 0.9");

    const gap = value.gap === undefined ? 8 : value.gap;
    if (typeof gap !== "number" || !isFinite(gap) || Math.floor(gap) !== gap)
        throw new Error("defaults.gap must be an integer between 0 and 64");
    if (gap < 0 || gap > 64)
        throw new Error("defaults.gap must be an integer between 0 and 64");

    return {
        masterRatio: masterRatio,
        gap: gap,
    };
}

function summary(options) {
    return id + " ratio=" + options.masterRatio + " gap=" + options.gap;
}

function clampRatio(value) {
    return Math.min(0.9, Math.max(0.1, value));
}

// Runtime split state is optional. Without it the configured defaults are used,
// so the same module remains usable by the config validator.
function stateRatio(defaults, state) {
    if (state && typeof state.masterRatio === "number" && isFinite(state.masterRatio))
        return clampRatio(state.masterRatio);

    return clampRatio(defaults.masterRatio);
}

function stateWeights(state, count) {
    if (!state || !Array.isArray(state.stackWeights) ||
        state.stackWeights.length !== count)
        return null;

    for (let i = 0; i < count; ++i) {
        const weight = state.stackWeights[i];
        if (typeof weight !== "number" || !isFinite(weight) || weight <= 0)
            return null;
    }

    return state.stackWeights.slice();
}

function fullGeometry(area) {
    return {
        x: Math.round(area.x),
        y: Math.round(area.y),
        width: Math.round(area.width),
        height: Math.round(area.height),
    };
}

function minimumFor(context, window) {
    const minimums = context.minimums || [];

    for (let i = 0; i < minimums.length; ++i) {
        if (minimums[i].window === window)
            return minimums[i];
    }

    return { width: 1, height: 1 };
}

// Collect the client minimums by slot. The master owns its own column, while
// every stack slot shares the same width, so the widest minimum in the stack
// decides the column width.
function constraintsFor(windows, context) {
    const constraints = {
        masterMinWidth: 1,
        stackMinWidth: 1,
        stackMinHeights: [],
    };

    for (let i = 0; i < windows.length; ++i) {
        const minimum = minimumFor(context, windows[i]);
        const width = Math.max(1, Math.ceil(minimum.width || 1));
        const height = Math.max(1, Math.ceil(minimum.height || 1));

        if (i === 0) {
            constraints.masterMinWidth = width;
        } else {
            constraints.stackMinWidth = Math.max(constraints.stackMinWidth, width);
            constraints.stackMinHeights.push(height);
        }
    }

    return constraints;
}

// Keep the configured ratio unless it would give a column less width than its
// windows can accept. When both minimum widths cannot fit, there is no valid
// split; keep the ratio and let the tiler keep the window on screen.
function masterColumnWidth(width, gap, ratio, constraints) {
    const desired = Math.max(1, Math.round((width - gap) * ratio));
    const minimum = Math.max(1, constraints.masterMinWidth);
    const stacked = Math.max(1, constraints.stackMinWidth);

    if (minimum + gap + stacked > width)
        return desired;

    const maximum = width - gap - stacked;
    return Math.min(Math.max(desired, minimum), maximum);
}

// Allocate a fixed height by weights. Slots whose client minimum does not fit
// their weighted share are pinned to that minimum first; the remaining height
// is then split by the remaining weights. The largest fractional parts get the
// leftover pixels so the stack always fills the full height.
function weightedStackHeights(total, weights, minimums) {
    const count = weights.length;
    const heights = [];
    const fixed = [];
    let remaining = total;
    let remainingWeight = 0;

    for (let i = 0; i < count; ++i) {
        heights.push(0);
        fixed.push(false);
        remainingWeight += weights[i];
    }

    let unfixed = count;

    while (unfixed > 0) {
        let fixedAny = false;

        for (let i = 0; i < count; ++i) {
            if (fixed[i])
                continue;

            const share = remainingWeight > 0
                ? remaining * weights[i] / remainingWeight
                : remaining / unfixed;
            const minimum = Math.max(1, minimums[i] || 1);

            if (minimum > share) {
                heights[i] = minimum;
                fixed[i] = true;
                remaining -= minimum;
                remainingWeight -= weights[i];
                --unfixed;
                fixedAny = true;
            }
        }

        if (fixedAny) {
            if (unfixed === 0)
                break;

            if (remaining <= 0)
                break;

            if (remainingWeight <= 0) {
                const share = Math.max(1, Math.floor(remaining / unfixed));
                for (let i = 0; i < count; ++i) {
                    if (!fixed[i]) {
                        heights[i] = share;
                        --unfixed;
                    }
                }
                break;
            }

            continue;
        }

        const fractions = [];
        let assigned = 0;

        for (let i = 0; i < count; ++i) {
            if (fixed[i])
                continue;

            const exact = remaining * weights[i] / remainingWeight;
            const base = Math.floor(exact);
            heights[i] = base;
            assigned += base;
            fractions.push({ index: i, remainder: exact - base });
        }

        let extra = Math.max(0, remaining - assigned);
        fractions.sort((a, b) => {
            if (Math.abs(a.remainder - b.remainder) > 0.000001)
                return b.remainder - a.remainder;
            return a.index - b.index;
        });

        for (let i = 0; i < extra && fractions.length > 0; ++i)
            ++heights[fractions[i % fractions.length].index];

        break;
    }

    return heights;
}

// Stack slots are equal by default. If a minimum does not fit the equal share,
// give that window its minimum and redistribute the remaining height. When the
// minima themselves do not fit, fall back to equal slots and let the tiler keep
// each window on screen. A resize records weights, which are used instead of
// equal shares while the window count still matches.
function stackHeights(height, count, gap, minimums, weights) {
    const total = Math.max(1, height - gap * (count - 1));
    const share = Math.max(1, Math.floor(total / count));
    const heights = [];
    let minimumTotal = 0;

    for (let i = 0; i < count; ++i)
        minimumTotal += Math.max(1, minimums[i] || 1);

    if (minimumTotal > total) {
        for (let i = 0; i < count; ++i)
            heights.push(share);
        return heights;
    }

    if (weights && weights.length === count)
        return weightedStackHeights(total, weights, minimums);

    let needsDistribution = false;
    for (let i = 0; i < count; ++i) {
        if (Math.max(1, minimums[i] || 1) > share) {
            needsDistribution = true;
            break;
        }
    }

    if (!needsDistribution) {
        for (let i = 0; i < count; ++i)
            heights.push(share);
        return heights;
    }

    // Water filling: slots whose minimum exceeds the equal share keep their
    // minimum, and the remaining height is split between the others.
    const fixed = [];
    for (let i = 0; i < count; ++i) {
        fixed.push(false);
        heights.push(0);
    }

    let remaining = total;
    let unfixed = count;

    while (unfixed > 0) {
        const currentShare = Math.max(1, Math.floor(remaining / unfixed));
        let progressed = false;

        for (let i = 0; i < count; ++i) {
            const minimum = Math.max(1, minimums[i] || 1);
            if (fixed[i] || minimum <= currentShare)
                continue;

            heights[i] = minimum;
            fixed[i] = true;
            remaining -= minimum;
            --unfixed;
            progressed = true;
        }

        if (progressed)
            continue;

        let extra = Math.max(0, remaining - currentShare * unfixed);
        for (let i = 0; i < count; ++i) {
            if (fixed[i])
                continue;

            heights[i] = currentShare;
            if (extra > 0) {
                ++heights[i];
                --extra;
            }
        }
        break;
    }

    return heights;
}

// Pick the master slot, then order the stack. A window snapped to the left
// owns the master column. Otherwise, windows pinned with an explicit
// float:false rule are the primary tiles, so a newly opened, unmatched window
// joins the stack instead of taking over the master slot. A window snapped to
// the right is placed at the top of the stack, directly next to the master.
function prioritize(windows, context) {
    if (windows.length === 0)
        return windows;

    const pinned = context.pinned || [];
    let primary = null;

    if (context.snapLeft && windows.indexOf(context.snapLeft) !== -1)
        primary = context.snapLeft;

    if (!primary) {
        for (let i = 0; i < windows.length; ++i) {
            if (pinned.indexOf(windows[i]) !== -1) {
                primary = windows[i];
                break;
            }
        }
    }

    if (!primary)
        primary = windows[0];

    const explicit = [];
    const automatic = [];

    for (let i = 0; i < windows.length; ++i) {
        const window = windows[i];
        if (window === primary)
            continue;

        if (pinned.indexOf(window) !== -1)
            explicit.push(window);
        else
            automatic.push(window);
    }

    const rest = explicit.concat(automatic);

    if (context.snapRight && context.snapRight !== primary) {
        const index = rest.indexOf(context.snapRight);
        if (index > 0) {
            rest.splice(index, 1);
            rest.unshift(context.snapRight);
        }
    }

    return [primary].concat(rest);
}

function tileGeometry(area, count, index, options, constraints, state) {
    const gap = Math.max(0, Math.round(options.gap));
    const ratio = stateRatio(options, state);
    // Round the work area once, then derive every slot from integers. KWin
    // reports fractional areas on scaled outputs (for example 1671.111 px).
    // Keeping the intermediate arithmetic fractional can make a slot come back
    // from the compositor at a slightly different size, which schedules another
    // arrange pass and can oscillate forever. Integer slots keep the target
    // stable; the tiler's one-pixel tolerance absorbs KWin's own rounding.
    const areaX = Math.round(area.x);
    const areaY = Math.round(area.y);
    const areaWidth = Math.max(1, Math.round(area.width));
    const areaHeight = Math.max(1, Math.round(area.height));
    const x = areaX + gap;
    const y = areaY + gap;
    const width = Math.max(1, areaWidth - gap * 2);
    const height = Math.max(1, areaHeight - gap * 2);

    if (count === 1)
        return fullGeometry(area);

    const masterWidth = masterColumnWidth(width, gap, ratio, constraints);
    if (index === 0)
        return { x: x, y: y, width: masterWidth, height: height };

    const stackCount = count - 1;
    const stackIndex = index - 1;
    const stackX = x + masterWidth + gap;
    const stackWidth = Math.max(1, width - masterWidth - gap);
    const weights = stateWeights(state, stackCount);
    const heights = stackHeights(height, stackCount, gap, constraints.stackMinHeights, weights);

    let stackY = y;
    for (let i = 0; i < stackIndex; ++i)
        stackY += heights[i] + gap;

    return {
        x: stackX,
        y: stackY,
        width: stackWidth,
        height: heights[stackIndex],
    };
}

// Layout interface: return one { window, geometry } entry per tiled window.
// The tiler applies the geometries in the returned order.
function arrange(context) {
    const windows = prioritize(context.windows, context);
    const placements = [];

    if (windows.length === 1) {
        placements.push({
            window: windows[0],
            geometry: fullGeometry(context.area),
        });
        return placements;
    }

    const constraints = constraintsFor(windows, context);

    for (let i = 0; i < windows.length; ++i) {
        placements.push({
            window: windows[i],
            geometry: tileGeometry(
                context.area,
                windows.length,
                i,
                context.defaults,
                constraints,
                context.state
            ),
        });
    }

    return placements;
}

// Turn an interactive resize into new split state. Only the edge that divides
// two tiles changes a split: the master's right edge and a stack window's left
// edge change masterRatio, while an inner stack boundary changes the stack
// weights. Outer edges are ignored and snap back during the final arrange.
function resize(context) {
    const windows = prioritize(context.windows, context);
    const index = windows.indexOf(context.window);
    if (index === -1 || windows.length < 2)
        return null;

    const geometry = context.geometry;
    const baseline = context.baseline;
    if (!geometry || !baseline)
        return null;

    const gap = Math.max(0, Math.round(context.defaults.gap));
    const areaX = Math.round(context.area.x);
    const areaWidth = Math.max(1, Math.round(context.area.width));
    const innerX = areaX + gap;
    const innerWidth = Math.max(1, areaWidth - gap * 2);
    const ratioBase = Math.max(1, innerWidth - gap);

    let masterRatio = stateRatio(context.defaults, context.state);
    let stackWeights = stateWeights(context.state, windows.length - 1);
    let changed = false;

    if (index === 0) {
        const divider = geometry.x + geometry.width;
        const previous = baseline.x + baseline.width;

        if (Math.abs(divider - previous) > 0.5) {
            masterRatio = clampRatio((divider - innerX) / ratioBase);
            changed = true;
        }
    }
    else {
        const divider = geometry.x;

        if (Math.abs(divider - baseline.x) > 0.5) {
            masterRatio = clampRatio((divider - innerX - gap) / ratioBase);
            changed = true;
        }
    }

    const stackCount = windows.length - 1;
    if (index > 0 && stackCount > 1) {
        const stackIndex = index - 1;
        const topMoved = stackIndex > 0 &&
            Math.abs(geometry.y - baseline.y) > 0.5;
        const bottomMoved = stackIndex < stackCount - 1 &&
            Math.abs((geometry.y + geometry.height) -
                (baseline.y + baseline.height)) > 0.5;

        if (topMoved || bottomMoved) {
            // Rebuild the split from the state at the start of the drag. Using
            // the live neighbour geometries would compound earlier frames and
            // make the stack drift away from the cursor.
            const baselineContext = {
                windows: context.windows,
                area: context.area,
                defaults: context.defaults,
                state: context.baselineState,
                pinned: context.pinned,
                minimums: context.minimums,
                snapLeft: context.snapLeft,
                snapRight: context.snapRight,
            };
            const baselinePlacements = arrange(baselineContext);
            const baselineHeights = [];

            for (let i = 1; i < windows.length; ++i) {
                let height = 0;

                for (let p = 0; p < baselinePlacements.length; ++p) {
                    if (baselinePlacements[p].window === windows[i]) {
                        height = baselinePlacements[p].geometry.height;
                        break;
                    }
                }

                if (!(height > 0))
                    return changed ? { masterRatio: masterRatio, stackWeights: stackWeights } : null;

                baselineHeights.push(height);
            }

            const areaY = Math.round(context.area.y);
            const stackTop = areaY + gap;

            const baselineAbove = (count) => {
                let total = 0;
                for (let i = 0; i < count; ++i)
                    total += baselineHeights[i];
                return total;
            };

            let boundary = null;

            if (topMoved) {
                const above = stackIndex;
                const delta = Math.round(geometry.y) - stackTop - gap * above -
                    baselineAbove(above);

                boundary = {
                    above: stackIndex - 1,
                    below: stackIndex,
                    delta: delta,
                    magnitude: Math.abs(delta),
                };
            }

            if (bottomMoved) {
                const above = stackIndex + 1;
                const delta = Math.round(geometry.y + geometry.height) -
                    stackTop - gap * stackIndex - baselineAbove(above);

                if (!boundary || Math.abs(delta) > boundary.magnitude) {
                    boundary = {
                        above: stackIndex,
                        below: stackIndex + 1,
                        delta: delta,
                        magnitude: Math.abs(delta),
                    };
                }
            }

            if (boundary && boundary.magnitude > 0.5) {
                const aboveMinimum = Math.max(
                    1,
                    minimumFor(context, windows[boundary.above + 1]).height || 1
                );
                const belowMinimum = Math.max(
                    1,
                    minimumFor(context, windows[boundary.below + 1]).height || 1
                );
                const maximum = baselineHeights[boundary.below] - belowMinimum;
                const minimum = -(baselineHeights[boundary.above] - aboveMinimum);
                const delta = Math.round(
                    Math.min(maximum, Math.max(minimum, boundary.delta))
                );

                if (Math.abs(delta) > 0.5) {
                    const heights = baselineHeights.slice();
                    heights[boundary.above] += delta;
                    heights[boundary.below] -= delta;
                    stackWeights = heights;
                    changed = true;
                }
            }
        }
    }

    if (!changed)
        return null;

    return {
        masterRatio: masterRatio,
        stackWeights: stackWeights,
    };
}

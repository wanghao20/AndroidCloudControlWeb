/**
 * UI 节点查看器：左侧截图点击拾取，右侧树 + 属性表联动
 */
(function (global) {
    const state = {
        root: null,
        flat: [],
        screenW: 0,
        screenH: 0,
        imageW: 0,
        imageH: 0,
        selected: null,
        selectedPath: "",
        searchQuery: "",
    };

    function parseBounds(str) {
        if (!str || typeof str !== "string") return null;
        const p = str.split(",").map((n) => parseInt(n, 10));
        if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
        const [left, top, right, bottom] = p;
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        return { left, top, right, bottom, width, height, area: width * height };
    }

    function nodeLabelParts(node) {
        const clsFull = node.className || "";
        const cls = clsFull.split(".").pop() || "Node";
        const text = (node.text || node.desc || "").trim();
        const textShort = text.length > 18 ? `${text.slice(0, 18)}…` : text;
        const id = node.id || "";
        const idTail = id.includes("/") ? id.split("/").pop() : id;
        const idShort =
            idTail.length > 22 ? `…${idTail.slice(-20)}` : idTail;
        const b = parseBounds(node.bounds);
        const size =
            b && (b.width > 0 || b.height > 0) ? `${b.width}×${b.height}` : "";
        const flags = [];
        if (node.clickable) flags.push("可点");
        if (node.scrollable) flags.push("可滚");
        const meta = [size, flags.join("")].filter(Boolean).join(" ");

        const titleLines = [
            clsFull && `class: ${clsFull}`,
            text && `text: ${text}`,
            node.desc && node.desc !== text && `desc: ${node.desc}`,
            id && `id: ${id}`,
            node.bounds && `bounds: ${node.bounds}`,
            node.packageName && `pkg: ${node.packageName}`,
        ].filter(Boolean);

        return {
            cls,
            text: textShort,
            id: idShort,
            meta,
            title: titleLines.join("\n"),
        };
    }

    function walkTree(node, path, parent, list) {
        if (!node || typeof node !== "object") return;
        const entry = {
            node,
            path,
            parent,
            bounds: parseBounds(node.bounds),
            children: [],
        };
        list.push(entry);
        const kids = Array.isArray(node.children) ? node.children : [];
        kids.forEach((ch, i) => {
            const childPath = path ? `${path}/${i}` : String(i);
            const childEntry = { node: ch, path: childPath, parent: entry, bounds: null, children: [] };
            entry.children.push(childEntry);
            walkTree(ch, childPath, entry, list);
        });
        entry.bounds = parseBounds(node.bounds);
    }

    function flattenFromRoot(root) {
        const flat = [];
        walkTree(root, "0", null, flat);
        return flat;
    }

    /** 扁平 nodes 数组按深度优先顺序，用 bounds 包含关系重建近似树 */
    function buildTreeFromFlatArray(nodes) {
        if (!Array.isArray(nodes) || !nodes.length) return null;
        const items = nodes.map((n, i) => ({
            ...n,
            _i: i,
            bounds: parseBounds(n.bounds),
            children: [],
        }));
        const stack = [];
        const roots = [];
        for (const item of items) {
            const node = { ...item };
            delete node._i;
            while (stack.length) {
                const top = stack[stack.length - 1];
                const tb = top.bounds;
                const ib = item.bounds;
                if (
                    tb &&
                    ib &&
                    tb.left <= ib.left &&
                    tb.top <= ib.top &&
                    tb.right >= ib.right &&
                    tb.bottom >= ib.bottom
                ) {
                    break;
                }
                stack.pop();
            }
            if (stack.length) {
                stack[stack.length - 1].children.push(node);
            } else {
                roots.push(node);
            }
            stack.push(node);
        }
        return roots[0] || items[0];
    }

    function tryViewerCanvasFallback() {
        const canvas = document.getElementById("deviceCanvas");
        if (!canvas || canvas.width < 2 || canvas.height < 2) return null;
        try {
            return {
                image: canvas.toDataURL("image/jpeg", 0.82),
                imageW: canvas.width,
                imageH: canvas.height,
                fromViewer: true,
            };
        } catch (_e) {
            return null;
        }
    }

    /**
     * 优先使用设备回传的截图（与节点 bounds 同一坐标系）。
     * 投屏 canvas 仅为 UI 容器尺寸且含黑边，会导致图缩小且无法点击拾取。
     */
    function resolveInspectorShot(data) {
        if (data.image) {
            return {
                image: data.image,
                imageW: data.imageW || data.screenW,
                imageH: data.imageH || data.screenH,
                imageSource: data.imageSource || "",
                imageFromViewer: false,
            };
        }
        const viewerShot = tryViewerCanvasFallback();
        if (viewerShot) {
            return {
                image: viewerShot.image,
                imageW: viewerShot.imageW,
                imageH: viewerShot.imageH,
                imageFromViewer: true,
            };
        }
        return { image: "", imageW: 0, imageH: 0, imageFromViewer: false };
    }

    function setInspectorImage(img, shot) {
        if (!img) return;
        if (!shot || !shot.image) {
            img.removeAttribute("src");
            img.style.display = "none";
            return;
        }
        img.style.display = "";
        const nextSrc = shot.image;
        if (img.src === nextSrc) {
            img.removeAttribute("src");
            requestAnimationFrame(() => {
                img.src = nextSrc;
            });
        } else {
            img.src = nextSrc;
        }
    }

    function clearInspectorImage() {
        const img = getEl("uiInspectorImage");
        if (img) {
            img.removeAttribute("src");
            img.style.display = "none";
        }
        const overlay = getEl("uiInspectorOverlay");
        if (overlay) {
            const ctx = overlay.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
    }

    function normalizePayload(msg) {
        let root = msg.root || (msg.raw && msg.raw.root) || null;
        const nodes = msg.nodes || (msg.raw && msg.raw.nodes);
        if (!root && nodes) root = buildTreeFromFlatArray(nodes);
        const screenW =
            msg.screenWidth ||
            msg.screen_width ||
            (msg.raw && (msg.raw.screenWidth || msg.raw.screen_width)) ||
            0;
        const screenH =
            msg.screenHeight ||
            msg.screen_height ||
            (msg.raw && (msg.raw.screenHeight || msg.raw.screen_height)) ||
            0;
        let image = msg.image || (msg.raw && msg.raw.image) || "";
        if (image && !image.startsWith("data:")) {
            image = `data:image/jpeg;base64,${image}`;
        }
        const imageW = msg.imageWidth || msg.image_width || (msg.raw && msg.raw.imageWidth) || 0;
        const imageH = msg.imageHeight || msg.image_height || (msg.raw && msg.raw.imageHeight) || 0;
        const imageSource = msg.imageSource || msg.image_source || (msg.raw && msg.raw.imageSource) || "";
        return { root, screenW, screenH, image, imageW, imageH, imageSource, imageFromViewer: false };
    }

    function formatShotHint(shot, imageSource) {
        if (!shot || !shot.image) return "（无截图）";
        if (shot.imageFromViewer) return "，截图来自当前投屏画面";
        const source = imageSource || shot.imageSource || "";
        if (source === "accessibility") return "，含实时屏幕截图";
        if (source === "logical_projection") return "，含设备全分辨率截图";
        if (source === "capture_buffer") return "，含投屏缓冲截图";
        if (source === "stream") return "，含投屏缓存截图（可能略滞后）";
        return "，含设备截图";
    }

    function mapClientToScreen(clientX, clientY, imgEl) {
        if (!imgEl || !state.screenW || !state.screenH) return null;
        const rect = imgEl.getBoundingClientRect();
        const naturalW = state.imageW || imgEl.naturalWidth || state.screenW;
        const naturalH = state.imageH || imgEl.naturalHeight || state.screenH;
        if (!naturalW || !naturalH) return null;
        const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
        const dw = naturalW * scale;
        const dh = naturalH * scale;
        const offsetX = (rect.width - dw) / 2;
        const offsetY = (rect.height - dh) / 2;
        const lx = clientX - rect.left - offsetX;
        const ly = clientY - rect.top - offsetY;
        if (lx < 0 || ly < 0 || lx > dw || ly > dh) return null;
        const imgX = lx / scale;
        const imgY = ly / scale;
        return {
            x: (imgX / naturalW) * state.screenW,
            y: (imgY / naturalH) * state.screenH,
        };
    }

    function hitTest(screenX, screenY) {
        let best = null;
        let bestArea = Infinity;
        for (const entry of state.flat) {
            const b = entry.bounds;
            if (!b || b.width <= 0 || b.height <= 0) continue;
            if (
                screenX >= b.left &&
                screenX <= b.right &&
                screenY >= b.top &&
                screenY <= b.bottom
            ) {
                if (b.area < bestArea) {
                    bestArea = b.area;
                    best = entry;
                }
            }
        }
        return best;
    }

    function getEl(id) {
        return document.getElementById(id);
    }

    function drawHighlight() {
        const canvas = getEl("uiInspectorOverlay");
        const img = getEl("uiInspectorImage");
        if (!canvas || !img) return;
        const rect = img.getBoundingClientRect();
        const wrap = img.parentElement;
        if (!wrap) return;
        const wrapRect = wrap.getBoundingClientRect();
        canvas.width = wrapRect.width;
        canvas.height = wrapRect.height;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!state.selected || !state.selected.bounds) return;

        const naturalW = state.imageW || img.naturalWidth || state.screenW;
        const naturalH = state.imageH || img.naturalHeight || state.screenH;
        const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
        const dw = naturalW * scale;
        const dh = naturalH * scale;
        const offsetX = (rect.width - dw) / 2 + (rect.left - wrapRect.left);
        const offsetY = (rect.height - dh) / 2 + (rect.top - wrapRect.top);

        const b = state.selected.bounds;
        const x1 = offsetX + (b.left / state.screenW) * dw;
        const y1 = offsetY + (b.top / state.screenH) * dh;
        const x2 = offsetX + (b.right / state.screenW) * dw;
        const y2 = offsetY + (b.bottom / state.screenH) * dh;

        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.fillStyle = "rgba(34, 197, 94, 0.12)";
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }

    function nodeMatchesQuery(node, query) {
        if (!query) return true;
        const q = query.toLowerCase();
        const parts = [
            node.text,
            node.desc,
            node.id,
            node.className,
            node.packageName,
            node.bounds,
        ];
        return parts.some((v) => v != null && String(v).toLowerCase().includes(q));
    }

    function subtreeHasMatch(node, query) {
        if (!query) return true;
        if (nodeMatchesQuery(node, query)) return true;
        const kids = Array.isArray(node.children) ? node.children : [];
        return kids.some((ch) => subtreeHasMatch(ch, query));
    }

    function countMatchingNodes(query) {
        if (!query) return 0;
        return state.flat.filter((entry) => nodeMatchesQuery(entry.node, query)).length;
    }

    function valueMatchesQuery(value, query) {
        if (!query) return true;
        const q = query.toLowerCase();
        const text = value === true ? "是" : value === false ? "否" : String(value ?? "");
        return text.toLowerCase().includes(q);
    }

    function updateSearchHint() {
        const hint = getEl("uiInspectorSearchHint");
        if (!hint) return;
        const query = state.searchQuery.trim();
        if (!query) {
            hint.textContent = "";
            hint.className = "ui-inspector-search-hint";
            return;
        }
        const count = countMatchingNodes(query);
        hint.className = "ui-inspector-search-hint " + (count ? "is-match" : "is-empty");
        hint.textContent = count ? `匹配 ${count} 个节点` : "未找到匹配节点";
    }

    function renderProps(node) {
        const tbody = getEl("uiInspectorPropsBody");
        if (!tbody) return;
        tbody.innerHTML = "";
        const query = state.searchQuery.trim();
        if (!node) {
            const tr = document.createElement("tr");
            tr.innerHTML = '<td colspan="2" class="props-empty">点击左侧截图或右侧节点树</td>';
            tbody.appendChild(tr);
            return;
        }
        const rows = [
            ["路径", state.selectedPath || "-"],
            ["text", node.text || ""],
            ["desc", node.desc || ""],
            ["id", node.id || ""],
            ["className", node.className || ""],
            ["packageName", node.packageName || ""],
            ["bounds", node.bounds || ""],
            ["clickable", node.clickable],
            ["enabled", node.enabled],
            ["scrollable", node.scrollable],
            ["editable", node.editable],
            ["focused", node.focused],
            ["selected", node.selected],
            ["checked", node.checked],
        ];
        let visibleCount = 0;
        for (const [k, v] of rows) {
            const rowText = `${k} ${v === true ? "是" : v === false ? "否" : String(v ?? "")}`;
            const matches =
                !query ||
                valueMatchesQuery(k, query) ||
                valueMatchesQuery(v, query) ||
                rowText.toLowerCase().includes(query.toLowerCase());
            if (!matches) continue;
            visibleCount++;
            const tr = document.createElement("tr");
            if (query) tr.classList.add("is-match");
            const tdK = document.createElement("td");
            const tdV = document.createElement("td");
            tdK.textContent = k;
            tdV.textContent = v === true ? "是" : v === false ? "否" : String(v ?? "");
            tr.appendChild(tdK);
            tr.appendChild(tdV);
            tbody.appendChild(tr);
        }
        if (query && visibleCount === 0) {
            const tr = document.createElement("tr");
            tr.innerHTML = '<td colspan="2" class="ui-inspector-props-empty">当前节点无匹配属性</td>';
            tbody.appendChild(tr);
        }
    }

    function selectByPath(path) {
        state.selectedPath = path;
        const entry = state.flat.find((e) => e.path === path);
        state.selected = entry || null;
        const container = getEl("uiInspectorTree");
        if (container) {
            container.querySelectorAll(".ui-tree-row").forEach((row) => {
                row.classList.toggle("selected", row.dataset.path === path);
            });
            const target = container.querySelector(
                `[data-path="${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`
            );
            if (target) target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        renderProps(entry ? entry.node : null);
        drawHighlight();
    }

    function renderTreeWithDataPath() {
        const container = getEl("uiInspectorTree");
        if (!container) return;
        container.innerHTML = "";
        if (!state.root) {
            container.textContent = "无节点数据";
            return;
        }

        function appendLabelSpans(row, parts) {
            const clsSpan = document.createElement("span");
            clsSpan.className = "ui-tree-cls";
            clsSpan.textContent = parts.cls;
            row.appendChild(clsSpan);

            if (parts.text) {
                const textSpan = document.createElement("span");
                textSpan.className = "ui-tree-text";
                textSpan.textContent = `"${parts.text}"`;
                row.appendChild(textSpan);
            }
            if (parts.id) {
                const idSpan = document.createElement("span");
                idSpan.className = "ui-tree-id";
                idSpan.textContent = `#${parts.id}`;
                row.appendChild(idSpan);
            }
            if (parts.meta) {
                const metaSpan = document.createElement("span");
                metaSpan.className = "ui-tree-meta";
                metaSpan.textContent = parts.meta;
                row.appendChild(metaSpan);
            }
        }

        function renderNode(node, path, depth) {
            const query = state.searchQuery.trim();
            if (query && !subtreeHasMatch(node, query)) return null;

            const wrap = document.createElement("div");
            wrap.className = "ui-tree-node";

            const row = document.createElement("div");
            row.className = "ui-tree-row";
            row.dataset.path = path;
            row.style.setProperty("--tree-depth", String(depth));
            const parts = nodeLabelParts(node);
            row.title = parts.title;
            if (state.selectedPath === path) row.classList.add("selected");
            if (query && nodeMatchesQuery(node, query)) row.classList.add("ui-tree-row--match");

            const kids = Array.isArray(node.children) ? node.children : [];
            const forceExpand = !!query;
            if (kids.length && !forceExpand) {
                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "ui-tree-toggle";
                toggle.setAttribute("aria-label", "展开/折叠");
                toggle.textContent = "▾";
                toggle.onclick = (e) => {
                    e.stopPropagation();
                    const ch = wrap.querySelector(":scope > .ui-tree-children");
                    if (!ch) return;
                    const hidden = ch.classList.toggle("collapsed");
                    toggle.textContent = hidden ? "▸" : "▾";
                };
                row.appendChild(toggle);
            } else {
                const spacer = document.createElement("span");
                spacer.className = "ui-tree-toggle ui-tree-toggle--empty";
                spacer.setAttribute("aria-hidden", "true");
                row.appendChild(spacer);
            }

            const label = document.createElement("span");
            label.className = "ui-tree-label";
            appendLabelSpans(label, parts);
            row.appendChild(label);

            row.onclick = () => selectByPath(path);
            wrap.appendChild(row);

            if (kids.length) {
                const chWrap = document.createElement("div");
                chWrap.className = "ui-tree-children";
                kids.forEach((ch, i) => {
                    const childPath = path ? `${path}/${i}` : String(i);
                    const childEl = renderNode(ch, childPath, depth + 1);
                    if (childEl) chWrap.appendChild(childEl);
                });
                if (chWrap.childElementCount) wrap.appendChild(chWrap);
            }
            return wrap;
        }

        const rootEl = renderNode(state.root, "0", 0);
        if (rootEl) {
            container.appendChild(rootEl);
        } else if (state.searchQuery.trim()) {
            container.textContent = "未找到匹配节点";
        }
        updateSearchHint();
    }

    function bindImageClick() {
        const wrap = getEl("uiInspectorShotWrap");
        const img = getEl("uiInspectorImage");
        const coords = getEl("uiInspectorCoords");
        if (!wrap || !img) return;

        const updateCoords = (clientX, clientY) => {
            if (!coords) return;
            const pt = mapClientToScreen(clientX, clientY, img);
            if (!pt) {
                coords.textContent = "x: —  y: —";
                return;
            }
            coords.textContent = `x: ${Math.round(pt.x)}  y: ${Math.round(pt.y)}`;
        };

        wrap.onmousemove = (e) => updateCoords(e.clientX, e.clientY);
        wrap.onmouseleave = () => {
            if (coords) coords.textContent = "x: —  y: —";
        };
        wrap.onclick = (e) => {
            const pt = mapClientToScreen(e.clientX, e.clientY, img);
            if (!pt) return;
            const hit = hitTest(pt.x, pt.y);
            if (hit) selectByPath(hit.path);
        };
        img.onload = () => {
            if (!state.imageW) state.imageW = img.naturalWidth;
            if (!state.imageH) state.imageH = img.naturalHeight;
            drawHighlight();
        };
        window.addEventListener("resize", drawHighlight);
    }

    function open(msg) {
        const modal = getEl("uiNodeModal");
        const status = getEl("uiNodeStatus");
        const panel = getEl("uiInspectorPanel");
        const legacy = getEl("uiNodeData");
        if (legacy) legacy.style.display = "none";
        if (panel) panel.style.display = "";
        if (modal) modal.classList.remove("hidden");

        const data = normalizePayload(msg);
        state.root = data.root;
        state.screenW = data.screenW;
        state.screenH = data.screenH;
        state.flat = data.root ? flattenFromRoot(data.root) : [];
        if ((!state.screenW || !state.screenH) && state.flat.length) {
            let maxR = 0;
            let maxB = 0;
            for (const e of state.flat) {
                if (!e.bounds) continue;
                maxR = Math.max(maxR, e.bounds.right);
                maxB = Math.max(maxB, e.bounds.bottom);
            }
            if (maxR > 0) state.screenW = maxR;
            if (maxB > 0) state.screenH = maxB;
        }
        state.selected = null;
        state.selectedPath = "";
        state.searchQuery = "";

        const searchInput = getEl("uiInspectorSearch");
        if (searchInput) searchInput.value = "";
        updateSearchHint();

        renderTreeWithDataPath();
        renderProps(null);

        const shot = resolveInspectorShot(data);
        state.imageW = shot.imageW || state.screenW;
        state.imageH = shot.imageH || state.screenH;
        setInspectorImage(getEl("uiInspectorImage"), shot);

        const count = state.flat.length;
        if (status) {
            const shotHint = formatShotHint(shot, data.imageSource);
            status.textContent = data.root
                ? `已加载 ${count} 个节点${shotHint}`
                : "未解析到节点树";
        }
        drawHighlight();
    }

    function showError(msg) {
        const status = getEl("uiNodeStatus");
        const panel = getEl("uiInspectorPanel");
        const legacy = getEl("uiNodeData");
        if (status) status.textContent = msg.error || msg.message || "获取节点信息失败";
        if (panel) panel.style.display = "none";
        if (legacy) {
            legacy.style.display = "";
            legacy.textContent = JSON.stringify(msg, null, 2);
        }
    }

    function showLoading(text) {
        const status = getEl("uiNodeStatus");
        const panel = getEl("uiInspectorPanel");
        const legacy = getEl("uiNodeData");
        if (status) status.textContent = text || "正在请求设备节点信息...";
        if (panel) panel.style.display = "none";
        clearInspectorImage();
        if (legacy) {
            legacy.style.display = "";
            legacy.textContent = "";
        }
    }

    function bindSearch() {
        const input = getEl("uiInspectorSearch");
        if (!input) return;

        const applySearch = () => {
            state.searchQuery = input.value || "";
            renderTreeWithDataPath();
            renderProps(state.selected?.node ?? null);
        };

        input.addEventListener("input", applySearch);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                input.value = "";
                applySearch();
                input.blur();
            }
        });
    }

    function bindTreeToolbar() {
        const expandBtn = getEl("uiTreeExpandAll");
        const collapseBtn = getEl("uiTreeCollapseAll");
        const tree = getEl("uiInspectorTree");
        if (!tree) return;

        const setAll = (collapsed) => {
            tree.querySelectorAll(".ui-tree-children").forEach((el) => {
                el.classList.toggle("collapsed", collapsed);
            });
            tree.querySelectorAll(".ui-tree-toggle:not(.ui-tree-toggle--empty)").forEach((btn) => {
                btn.textContent = collapsed ? "▸" : "▾";
            });
        };

        if (expandBtn) expandBtn.onclick = () => setAll(false);
        if (collapseBtn) collapseBtn.onclick = () => setAll(true);
    }

    bindImageClick();
    bindSearch();
    bindTreeToolbar();

    global.UiInspector = { open, showError, showLoading };
})(window);

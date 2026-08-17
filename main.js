const {
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  setIcon,
} = require("obsidian");

const HOME_VIEW_TYPE = "hobbit-home";
const DIARY_VIEW_TYPE = "hobbit-diary";
const DAILY_NOTES_PLUGIN_ID = "daily-notes";

const DEFAULT_SETTINGS = {
  attachmentFolder: "Hobbit/Attachments",
};

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
]);

class HobbitPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    this.refreshTimer = null;
    this.editorChromeTimer = null;
    this.editorChromeRevision = 0;
    this.hobbitNativeFullscreenOwned = false;
    this.hobbitLeaf = null;
    this.hobbitEditorLeaves = new WeakSet();

    this.registerView(HOME_VIEW_TYPE, (leaf) => new HobbitHomeView(leaf, this));
    this.registerView(DIARY_VIEW_TYPE, (leaf) => new HobbitDiaryView(leaf, this));

    const ribbonIcon = this.addRibbonIcon("mountain", "打开 Hobbit 主页", () => {
      void this.activateHome();
    });
    ribbonIcon.classList.add("hobbit-ribbon-icon");
    setHobbitCaveIcon(ribbonIcon);

    this.addCommand({
      id: "open-home",
      name: "打开 Hobbit 主页",
      callback: () => void this.activateHome(),
    });

    this.addCommand({
      id: "write-today",
      name: "写今天的日记",
      callback: () => void this.createTodayDiary(),
    });

    this.addSettingTab(new HobbitSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.vault.on("modify", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.scheduleEditorChromeRefresh();
        this.updateMobileFullscreen(leaf);
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleEditorChromeRefresh();
        this.updateMobileFullscreen();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.scheduleEditorChromeRefresh();
        this.updateMobileFullscreen();
      })
    );
    this.updateMobileFullscreen();
    this.scheduleEditorChromeRefresh();
  }

  onunload() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.editorChromeTimer) window.clearTimeout(this.editorChromeTimer);
    this.removeEditorChromeFromAllLeaves();
    this.updateMobileFullscreen(null);
    this.hobbitLeaf = null;
    this.hobbitEditorLeaves = new WeakSet();
  }

  async activateHome() {
    const leaf = this.getHobbitLeaf();
    this.markHobbitLeaf(leaf);
    await leaf.setViewState({ type: HOME_VIEW_TYPE, active: true });
    this.pruneDuplicateHobbitLeaves(leaf);
    this.app.workspace.revealLeaf(leaf);
    this.updateMobileFullscreen(leaf);
  }

  isHobbitLeaf(leaf) {
    const view = leaf?.view;
    const viewType = view?.getViewType?.();
    if (viewType === HOME_VIEW_TYPE || viewType === DIARY_VIEW_TYPE) {
      return true;
    }

    return (
      viewType === "markdown" &&
      (this.hobbitEditorLeaves.has(leaf) ||
        leaf.containerEl?.classList.contains("hobbit-page-leaf")) &&
      view.file instanceof TFile &&
      Boolean(this.getDailyNoteDate(view.file))
    );
  }

  markHobbitLeaf(leaf, editor = false) {
    if (!leaf) return leaf;
    this.hobbitLeaf = leaf;
    leaf.containerEl?.classList.add("hobbit-page-leaf");
    if (editor) this.hobbitEditorLeaves.add(leaf);
    return leaf;
  }

  getWorkspaceLeaves() {
    return Array.from(
      new Set([
        ...this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE),
        ...this.app.workspace.getLeavesOfType(DIARY_VIEW_TYPE),
        ...this.app.workspace.getLeavesOfType("markdown"),
        this.app.workspace.activeLeaf,
      ].filter(Boolean))
    );
  }

  getHobbitLeaf() {
    const leaves = this.getWorkspaceLeaves();
    if (
      this.hobbitLeaf &&
      leaves.includes(this.hobbitLeaf) &&
      this.isHobbitLeaf(this.hobbitLeaf)
    ) {
      return this.hobbitLeaf;
    }

    this.hobbitLeaf = null;
    const activeLeaf = this.app.workspace.activeLeaf;
    if (this.isHobbitLeaf(activeLeaf)) {
      return this.markHobbitLeaf(activeLeaf);
    }

    const existingHobbitLeaf = leaves.find((leaf) => this.isHobbitLeaf(leaf));
    if (existingHobbitLeaf) {
      return this.markHobbitLeaf(existingHobbitLeaf);
    }

    // Recover the dedicated page after a plugin reload while its native diary
    // editor is active. Only the active daily note is claimed; unrelated tabs
    // elsewhere in the workspace remain untouched.
    if (
      activeLeaf?.view?.getViewType?.() === "markdown" &&
      activeLeaf.view.file instanceof TFile &&
      this.getDailyNoteDate(activeLeaf.view.file)
    ) {
      return this.markHobbitLeaf(activeLeaf, true);
    }

    // Hobbit owns one dedicated tab. Once created, home, reader and Obsidian's
    // native Markdown editor all replace the view inside this same leaf.
    return this.markHobbitLeaf(this.app.workspace.getLeaf("tab"));
  }

  pruneDuplicateHobbitLeaves(keepLeaf) {
    for (const leaf of this.getWorkspaceLeaves()) {
      if (leaf !== keepLeaf && this.isHobbitLeaf(leaf)) leaf.detach();
    }
  }

  async openDiary(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("Hobbit 找不到这篇日记");
      return;
    }

    const leaf = this.getHobbitLeaf();
    this.markHobbitLeaf(leaf);
    await leaf.setViewState({
      type: DIARY_VIEW_TYPE,
      state: { path: file.path },
      active: true,
    });
    this.pruneDuplicateHobbitLeaves(leaf);
    this.app.workspace.revealLeaf(leaf);
    this.updateMobileFullscreen(leaf);
  }

  async openNativeEditor(file) {
    if (!(file instanceof TFile)) return;
    const leaf = this.getHobbitLeaf();
    this.markHobbitLeaf(leaf);
    await leaf.openFile(file, { active: true });
    this.markHobbitLeaf(leaf, true);

    // Hobbit's edit entry is explicit: always leave the note in Obsidian's
    // source editor, even when the note was previously opened in reading mode.
    // Use the leaf state API so Obsidian resolves its own Markdown mode object.
    const viewState = leaf.getViewState?.();
    if (viewState?.type === "markdown") {
      viewState.state = { ...viewState.state, mode: "source" };
      await leaf.setViewState(viewState, { focus: true });
      leaf.view?.editor?.focus?.();
    }

    this.pruneDuplicateHobbitLeaves(leaf);
    this.scheduleEditorChromeRefresh();
    this.updateMobileFullscreen(leaf);
  }

  async openImage(image) {
    const source = getImageSource(image, this.app);
    if (!source) return;
    const modal = new Modal(this.app);
    modal.setTitle("照片");
    modal.modalEl.classList.add("hobbit-image-modal");
    modal.onOpen = () => {
      const imageEl = document.createElement("img");
      imageEl.className = "hobbit-image-modal-image";
      imageEl.src = source;
      imageEl.alt = "日记照片";
      imageEl.decoding = "async";
      modal.contentEl.appendChild(imageEl);
    };
    modal.open();
  }

  async createTodayDiary() {
    const source = this.getDailyNotesSource();
    if (!source) {
      new Notice("请先启用 Obsidian 核心插件“日记”");
      return;
    }

    let file = null;
    try {
      file = await source.instance.getDailyNote();
    } catch (error) {
      console.error("Hobbit 无法通过核心日记插件创建日记", error);
      new Notice("核心日记插件无法创建今天的日记，请检查它的文件夹和日期格式设置");
      return;
    }

    if (!(file instanceof TFile)) {
      new Notice("核心日记插件没有返回今天的日记，请检查它的文件夹和日期格式设置");
      return;
    }
    await this.openNativeEditor(file);
  }

  async createDiaryForDate(date) {
    const source = this.getDailyNotesSource();
    if (!source) {
      new Notice("请先启用 Obsidian 核心插件“日记”");
      return;
    }

    const selectedDate = window.moment(date, "YYYY-MM-DD", true);
    if (!selectedDate?.isValid?.()) {
      new Notice("无法识别选中的日期");
      return;
    }

    const relativePath = `${selectedDate.format(source.format)}.md`;
    const path = normalizePath(
      source.folderPath ? `${source.folderPath}/${relativePath}` : relativePath
    );
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.openNativeEditor(existing);
      return;
    }
    if (existing) {
      new Notice("选中日期的日记路径已被文件夹占用");
      return;
    }

    try {
      const parentPath = path.split("/").slice(0, -1).join("/");
      if (parentPath) await this.ensureFolder(parentPath);
      const content = await this.getDailyNoteTemplateContent(source, selectedDate);
      const file = await this.app.vault.create(path, content);
      await this.openNativeEditor(file);
    } catch (error) {
      const created = this.app.vault.getAbstractFileByPath(path);
      if (created instanceof TFile) {
        await this.openNativeEditor(created);
        return;
      }
      console.error("Hobbit 无法创建选中日期的日记", error);
      new Notice("无法创建这一天的日记，请检查日记文件夹和模板设置");
    }
  }

  confirmCreateDiary(date) {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        modal.close();
      };

      modal.modalEl.classList.add("hobbit-confirm-modal");
      modal.setTitle("创建这一天的日记？");
      modal.onOpen = () => {
        modal.contentEl.replaceChildren();
        modal.contentEl.append(
          el("p", "hobbit-confirm-date", formatLongDate(date)),
          el("p", "hobbit-confirm-copy", "这一天还没有日记，是否现在创建？")
        );
        const actions = el("div", "hobbit-confirm-actions");
        const cancel = button("取消", "hobbit-confirm-button is-secondary");
        const confirm = button("创建日记", "hobbit-confirm-button is-primary", "pen-line");
        cancel.addEventListener("click", () => finish(false));
        confirm.addEventListener("click", () => finish(true));
        actions.append(cancel, confirm);
        modal.contentEl.appendChild(actions);
        confirm.focus();
      };
      modal.onClose = () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      modal.open();
    });
  }

  async getDailyNoteTemplateContent(source, selectedDate) {
    const templateSetting = source.instance.options?.template;
    const templatePath =
      typeof templateSetting === "string"
        ? normalizePath(templateSetting.trim()).replace(/^\/+|\/+$/g, "")
        : "";
    if (!templatePath) return "";

    const candidates = [templatePath];
    if (!templatePath.toLowerCase().endsWith(".md")) {
      candidates.push(`${templatePath}.md`);
    }
    const templateFile = candidates
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .find((file) => file instanceof TFile);
    if (!(templateFile instanceof TFile)) return "";

    const raw = await this.app.vault.cachedRead(templateFile);
    const now = window.moment();
    const title = selectedDate.format(source.format).split("/").pop();
    return raw
      .replace(/\{\{date(?::([^}]+))?\}\}/gi, (_match, format) =>
        selectedDate.format(format?.trim() || "YYYY-MM-DD")
      )
      .replace(/\{\{time(?::([^}]+))?\}\}/gi, (_match, format) =>
        now.format(format?.trim() || "HH:mm")
      )
      .replace(/\{\{title\}\}/gi, title);
  }

  getDailyNotesSource() {
    const internal = this.app.internalPlugins?.getEnabledPluginById?.(
      DAILY_NOTES_PLUGIN_ID
    );
    const instance = internal?.instance || internal;
    if (!instance || typeof instance.getDailyNote !== "function") return null;

    const folder =
      typeof instance.getFolder === "function" ? instance.getFolder() : null;
    if (instance.options?.folder && !folder) return null;
    const format =
      typeof instance.getFormat === "function"
        ? instance.getFormat()
        : instance.options?.format || "YYYY-MM-DD";
    if (typeof format !== "string" || !format.trim()) return null;

    return {
      instance,
      folderPath: normalizePath(folder?.path || "").replace(/\/$/, ""),
      format,
    };
  }

  getDailyNoteDate(file, source = this.getDailyNotesSource()) {
    if (!(file instanceof TFile) || file.extension !== "md" || !source) {
      return "";
    }

    const folderPath = source.folderPath;
    let relativePath = file.path;
    if (folderPath) {
      const prefix = `${folderPath}/`;
      if (!file.path.startsWith(prefix)) return "";
      relativePath = file.path.slice(prefix.length);
    }

    if (!relativePath.toLowerCase().endsWith(".md")) return "";
    const dateText = relativePath.slice(0, -3);
    if (!dateText) return "";

    try {
      const parsed = window.moment(dateText, source.format, true);
    return parsed?.isValid?.() ? parsed.format("YYYY-MM-DD") : "";
    } catch (error) {
      return "";
    }
  }

  getFrontmatter(file, raw) {
    const cached =
      file instanceof TFile
        ? this.app.metadataCache.getFileCache(file)?.frontmatter
        : null;
    return cached ? { ...cached } : parseFrontmatter(raw);
  }

  async ensureFolder(folderPath) {
    const normalized = normalizePath(folderPath).replace(/\/$/, "");
    if (!normalized) return;
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async getDiaryEntries() {
    const source = this.getDailyNotesSource();
    if (!source) return [];

    const files = this.app.vault.getMarkdownFiles();
    const entries = [];
    for (const file of files) {
      const date = this.getDailyNoteDate(file, source);
      if (!date) continue;

      const raw = await this.app.vault.cachedRead(file);
      const frontmatter = this.getFrontmatter(file, raw);

      const body = stripFrontmatter(raw);
      const title =
        cleanText(frontmatter.title) ||
        extractHeading(body) ||
        formatLongDate(date);
      const images = this.resolveImages(raw, file);
      entries.push({
        file,
        raw,
        body,
        frontmatter,
        date,
        title,
        preview: makePreview(body, title),
        tags: collectTags(frontmatter, body),
        favorite: frontmatter.favorite === true || frontmatter.favorite === "true",
        images,
      });
    }

    entries.sort((a, b) => {
      const dateOrder = b.date.localeCompare(a.date);
      if (dateOrder !== 0) return dateOrder;
      return b.file.stat.mtime - a.file.stat.mtime;
    });
    return entries;
  }

  resolveImages(raw, sourceFile) {
    const links = [];
    const imagePattern = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
    let match;
    while ((match = imagePattern.exec(raw))) {
      links.push((match[1] || match[2] || "").trim());
    }

    const result = [];
    const seen = new Set();
    for (const rawLink of links) {
      const link = cleanImageTarget(rawLink);
      if (!link) continue;
      if (/^(https?:|data:)/i.test(link)) {
        const key = `remote:${link}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(link);
        continue;
      }
      const destination = this.app.metadataCache.getFirstLinkpathDest(
        link,
        sourceFile.path
      );
      if (!destination || !IMAGE_EXTENSIONS.has(destination.extension.toLowerCase())) {
        continue;
      }
      const key = `vault:${destination.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(destination);
    }
    return result;
  }

  async setFavorite(file, value) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.favorite = value;
    });
    this.scheduleRefresh();
  }

  async addTag(file, rawTag) {
    const tag = rawTag.trim().replace(/^#/, "");
    if (!tag) return;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const current = normalizeTags(frontmatter.tags);
      if (!current.includes(tag)) current.push(tag);
      frontmatter.tags = current;
    });
    new Notice(`已添加标签 #${tag}`);
    this.scheduleRefresh();
  }

  async addPhoto(file, imageFile, editorView = null) {
    if (!(file instanceof TFile) || !imageFile) return;
    await this.ensureFolder(this.settings.attachmentFolder);
    const ext = extensionFromName(imageFile.name) || "png";
    const stem = sanitizeFilename(imageFile.name.replace(/\.[^.]+$/, "")) || "photo";
    const timestamp = Date.now();
    let filename = `${file.basename}-${timestamp}-${stem}.${ext}`;
    let attachmentPath = normalizePath(`${this.settings.attachmentFolder}/${filename}`);
    let collision = 2;
    while (this.app.vault.getAbstractFileByPath(attachmentPath)) {
      filename = `${file.basename}-${timestamp}-${stem}-${collision}.${ext}`;
      attachmentPath = normalizePath(`${this.settings.attachmentFolder}/${filename}`);
      collision += 1;
    }
    const data = await imageFile.arrayBuffer();
    await this.app.vault.createBinary(attachmentPath, data);
    const link = `![[${attachmentPath}]]`;
    const targetView = editorView || this.getMarkdownViewForFile(file);
    const editor = targetView?.file?.path === file.path ? targetView.editor : null;
    const cursor = editor?.getCursor?.();
    if (editor && cursor && typeof editor.replaceRange === "function") {
      const line = typeof editor.getLine === "function" ? editor.getLine(cursor.line) : "";
      const beforeCursor = line.slice(0, cursor.ch);
      const prefix = beforeCursor.trim() ? "\n\n" : "";
      editor.replaceRange(`${prefix}${link}\n`, cursor);
    } else {
      const current = await this.app.vault.read(file);
      const next = `${current.replace(/\s*$/, "")}\n\n${link}\n`;
      await this.app.vault.modify(file, next);
    }
    new Notice("照片已加入日记");
    this.scheduleRefresh();
    this.scheduleEditorChromeRefresh();
  }

  scheduleRefresh() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshViews();
    }, 180);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)) {
      leaf.view.refresh?.();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(DIARY_VIEW_TYPE)) {
      leaf.view.refresh?.();
    }
  }

  scheduleEditorChromeRefresh() {
    if (this.editorChromeTimer) window.clearTimeout(this.editorChromeTimer);
    this.editorChromeTimer = window.setTimeout(() => {
      this.editorChromeTimer = null;
      void this.refreshEditorChrome();
    }, 80);
  }

  async refreshEditorChrome() {
    const revision = ++this.editorChromeRevision;
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (revision !== this.editorChromeRevision) return;
      await this.updateEditorChrome(leaf, revision);
    }
  }

  async updateEditorChrome(leaf, revision) {
    const view = leaf?.view;
    const contentEl = view?.contentEl;
    if (!contentEl || view?.getViewType?.() !== "markdown") return;

    const file = view.file;
    if (!(file instanceof TFile) || file.extension !== "md") {
      this.removeEditorChrome(view);
      return;
    }

    const raw = await this.app.vault.cachedRead(file);
    if (revision !== this.editorChromeRevision) return;
    const frontmatter = this.getFrontmatter(file, raw);
    if (!this.getDailyNoteDate(file)) {
      this.removeEditorChrome(view);
      return;
    }

    const entries = await this.getDiaryEntries();
    if (revision !== this.editorChromeRevision) return;
    this.renderEditorChrome(view, file, raw, frontmatter, entries);
  }

  removeEditorChromeFromAllLeaves() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      this.removeEditorChrome(leaf.view);
    }
  }

  removeEditorChrome(view) {
    const contentEl = view?.contentEl;
    if (!contentEl) return;
    for (const child of Array.from(contentEl.children)) {
      if (child.classList?.contains("hobbit-editor-companion")) child.remove();
    }
    contentEl.classList.remove(
      "hobbit-diary-editor",
      "hobbit-show-properties",
      "hobbit-generated-heading"
    );
  }

  updateMobileFullscreen(leaf = this.app.workspace.activeLeaf) {
    const view = leaf?.view;
    const viewType = view?.getViewType?.();
    const file = view?.file;
    const isDiaryMarkdown =
      viewType === "markdown" &&
      file instanceof TFile &&
      this.getDailyNoteDate(file);
    const isHobbitView =
      viewType === HOME_VIEW_TYPE || viewType === DIARY_VIEW_TYPE || isDiaryMarkdown;
    document.body?.classList.toggle("hobbit-mobile-fullscreen", isHobbitView);
    this.updateNativeMobileFullscreen(isHobbitView);
  }

  updateNativeMobileFullscreen(shouldEnter) {
    const body = document.body;
    if (!body) return;
    const isPhone = body.classList.contains("is-phone");
    const mobileNavbar = this.app.mobileNavbar;

    if (!shouldEnter || !isPhone) {
      body.classList.remove("hobbit-native-fullscreen");
      if (!isPhone && !this.hobbitNativeFullscreenOwned) return;
      if (!this.hobbitNativeFullscreenOwned) return;
      if (typeof mobileNavbar?.restoreNavigation === "function") {
        body.classList.add("is-hidden-nav");
        mobileNavbar.restoreNavigation(false);
      } else {
        body.classList.remove("is-hidden-nav");
      }
      this.hobbitNativeFullscreenOwned = false;
      return;
    }

    if (shouldEnter) {
      if (this.hobbitNativeFullscreenOwned) {
        body.classList.remove("is-hidden-nav");
        return;
      }
      if (typeof mobileNavbar?.hideNavigation !== "function") return;

      // Reuse Obsidian's native full-screen transition for the warm edge-to-edge
      // background, then keep the native floating navigation visible.
      try {
        mobileNavbar.hideNavigation();
      } catch (error) {
        console.warn("Hobbit 无法启用移动端沉浸模式", error);
        return;
      }
      this.hobbitNativeFullscreenOwned = true;
      body.classList.add("hobbit-native-fullscreen");
      body.classList.remove("is-hidden-nav");

      const keepNavigationVisible = () => {
        if (
          this.hobbitNativeFullscreenOwned &&
          body.classList.contains("hobbit-native-fullscreen")
        ) {
          body.classList.remove("is-hidden-nav");
        }
      };
      window.setTimeout(keepNavigationVisible, 0);
      window.setTimeout(keepNavigationVisible, 120);
      return;
    }
  }

  getMarkdownViewForFile(file) {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((view) => view?.file?.path === file.path) || null;
  }

  renderEditorChrome(view, file, raw, frontmatter, entries) {
    const contentEl = view.contentEl;
    const body = stripFrontmatter(raw);
    const date = this.getDailyNoteDate(file);
    const tags = collectTags(frontmatter, body);
    const images = this.resolveImages(raw, file);
    const favorite = frontmatter.favorite === true || frontmatter.favorite === "true";
    const statBody = isGeneratedDiaryHeading(body, date) ? removeFirstHeading(body) : body;
    const index = entries.findIndex((entry) => entry.file.path === file.path);
    const previous = index >= 0 ? entries[index + 1] : null;
    const next = index > 0 ? entries[index - 1] : null;
    const existing = Array.from(contentEl.children).find((child) =>
      child.classList?.contains("hobbit-editor-companion")
    );
    const infoOpen = existing?.classList.contains("is-info-open") || false;

    contentEl.classList.add("hobbit-diary-editor");
    if (this.app.workspace.activeLeaf?.view === view) {
      this.updateMobileFullscreen(this.app.workspace.activeLeaf);
    }
    contentEl.classList.toggle(
      "hobbit-generated-heading",
      isGeneratedDiaryHeading(body, date)
    );

    const chrome = existing || el("div", "hobbit-editor-companion");
    chrome.classList.toggle("is-info-open", infoOpen);
    chrome.replaceChildren();
    if (!existing) contentEl.prepend(chrome);

    const main = el("div", "hobbit-editor-companion-main");
    const context = el("div", "hobbit-editor-context");
    context.appendChild(el("span", "hobbit-editor-kicker", "HOBBIT / DAILY ARCHIVE"));
    context.appendChild(el("strong", "hobbit-editor-date", formatLongDate(date)));
    const status = [weekdayFor(date), `${countWords(statBody)} 字`];
    if (images.length) status.push(`${images.length} 张照片`);
    context.appendChild(el("span", "hobbit-editor-status", status.join(" · ")));
    main.appendChild(context);

    const actions = el("div", "hobbit-editor-companion-actions");
    const navigationActions = el(
      "div",
      "hobbit-editor-action-group hobbit-editor-navigation-actions"
    );
    const diaryActions = el(
      "div",
      "hobbit-editor-action-group hobbit-editor-diary-actions"
    );
    const homeButton = iconButton("打开 Hobbit 主页", "home");
    homeButton.classList.add("hobbit-editor-icon-button");
    homeButton.addEventListener("click", () => void this.activateHome());
    navigationActions.appendChild(homeButton);

    const previousButton = iconButton(
      previous ? `前一天 · ${formatMonthDay(previous.date)}` : "没有更早的日记",
      "chevron-left"
    );
    previousButton.classList.add("hobbit-editor-icon-button");
    previousButton.disabled = !previous;
    previousButton.addEventListener("click", () => {
      if (previous) void this.openNativeEditor(previous.file);
    });
    navigationActions.appendChild(previousButton);

    const nextButton = iconButton(
      next ? `后一天 · ${formatMonthDay(next.date)}` : "没有更新的日记",
      "chevron-right"
    );
    nextButton.classList.add("hobbit-editor-icon-button");
    nextButton.disabled = !next;
    nextButton.addEventListener("click", () => {
      if (next) void this.openNativeEditor(next.file);
    });
    navigationActions.appendChild(nextButton);

    const photoButton = button("照片", "hobbit-editor-action-button", "image-plus");
    photoButton.setAttribute("aria-label", "添加照片");
    photoButton.title = "添加照片";
    const photoInput = document.createElement("input");
    photoInput.type = "file";
    photoInput.accept = "image/*";
    photoInput.multiple = true;
    photoInput.className = "hobbit-hidden-input";
    photoInput.addEventListener("change", () => {
      const selectedFiles = Array.from(photoInput.files || []);
      void (async () => {
        for (const selected of selectedFiles) {
          await this.addPhoto(file, selected, view);
        }
      })();
      photoInput.value = "";
    });
    photoButton.addEventListener("click", () => photoInput.click());
    diaryActions.append(photoButton, photoInput);

    const tagButton = button("标签", "hobbit-editor-action-button", "tag");
    tagButton.setAttribute("aria-label", "添加标签");
    tagButton.title = "添加标签";
    tagButton.addEventListener("click", () => {
      const value = window.prompt("输入标签，不需要输入 #");
      if (value) {
        void this.addTag(file, value).then(() => this.scheduleEditorChromeRefresh());
      }
    });
    diaryActions.appendChild(tagButton);

    const favoriteButton = button(
      favorite ? "已收藏" : "收藏",
      "hobbit-editor-action-button",
      "star"
    );
    favoriteButton.setAttribute("aria-label", favorite ? "取消收藏" : "收藏");
    favoriteButton.title = favorite ? "取消收藏" : "收藏";
    favoriteButton.classList.toggle("is-active", favorite);
    favoriteButton.addEventListener("click", () => {
      void this.setFavorite(file, !favorite).then(() => this.scheduleEditorChromeRefresh());
    });
    diaryActions.appendChild(favoriteButton);

    const infoButton = button("日记信息", "hobbit-editor-action-button", "info");
    infoButton.setAttribute("aria-label", "日记信息");
    infoButton.title = "日记信息";
    infoButton.setAttribute("aria-expanded", String(infoOpen));
    infoButton.addEventListener("click", () => {
      const open = chrome.classList.toggle("is-info-open");
      infoButton.setAttribute("aria-expanded", String(open));
    });
    diaryActions.appendChild(infoButton);

    const readerButton = button("阅读", "hobbit-editor-action-button", "book-open");
    readerButton.setAttribute("aria-label", "阅读模式");
    readerButton.title = "阅读模式";
    readerButton.addEventListener("click", () => void this.openDiary(file.path));
    diaryActions.appendChild(readerButton);

    actions.append(navigationActions, diaryActions);

    main.appendChild(actions);
    chrome.appendChild(main);

    const info = el("div", "hobbit-editor-info-panel");
    info.setAttribute("aria-hidden", String(!infoOpen));
    const infoSummary = el("div", "hobbit-editor-info-summary");
    infoSummary.append(
      el("span", "hobbit-editor-info-label", "这篇日记"),
      el("span", "hobbit-editor-info-value", `${formatLongDate(date)} · ${countWords(statBody)} 字${images.length ? ` · ${images.length} 张照片` : ""}`)
    );
    info.appendChild(infoSummary);
    const tagRow = el("div", "hobbit-editor-info-row");
    tagRow.appendChild(el("span", "hobbit-editor-info-label", "标签"));
    const tagList = el("div", "hobbit-editor-info-tags");
    if (tags.length) {
      for (const tag of tags) tagList.appendChild(el("span", "hobbit-tag", `#${tag}`));
    } else {
      tagList.appendChild(el("span", "hobbit-editor-empty-value", "还没有标签"));
    }
    tagRow.appendChild(tagList);
    info.appendChild(tagRow);

    const infoActions = el("div", "hobbit-editor-info-actions");
    const showProperties = contentEl.classList.contains("hobbit-show-properties");
    const propertyButton = button(
      showProperties ? "隐藏原生属性" : "显示原生属性",
      "hobbit-editor-detail-button",
      "sliders-horizontal"
    );
    propertyButton.addEventListener("click", () => {
      const visible = contentEl.classList.toggle("hobbit-show-properties");
      propertyButton.replaceChildren();
      setIcon(propertyButton, "sliders-horizontal");
      propertyButton.appendChild(document.createTextNode(visible ? "隐藏原生属性" : "显示原生属性"));
    });
    infoActions.appendChild(propertyButton);
    info.appendChild(infoActions);
    chrome.appendChild(info);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshViews();
  }
}

class HobbitHomeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filter = "all";
    this.searchText = "";
    this.searchOpen = false;
    this.dateFilter = null;
    this.calendarDate = new Date();
    this.calendarOpen = false;
    this.entries = [];
  }

  getViewType() {
    return HOME_VIEW_TYPE;
  }

  getDisplayText() {
    return "Hobbit";
  }

  getIcon() {
    return "mountain";
  }

  async onOpen() {
    this.render();
    await this.refresh();
  }

  async onClose() {
    this.contentEl.replaceChildren();
  }

  async refresh() {
    if (!this.listEl) return;
    this.entries = await this.plugin.getDiaryEntries();
    this.updateHero();
    this.renderCalendar();
    this.renderList();
  }

  render() {
    this.contentEl.replaceChildren();
    this.contentEl.className = "view-content hobbit-view-content";

    const shell = el("div", "hobbit-shell");
    this.contentEl.appendChild(shell);

    const topbar = el("header", "hobbit-topbar");
    shell.appendChild(topbar);
    const brand = el("div", "hobbit-brand");
    const brandIcon = el("span", "hobbit-brand-icon");
    setHobbitCaveIcon(brandIcon);
    brand.append(brandIcon, el("span", "hobbit-brand-name", "Hobbit"));
    topbar.appendChild(brand);

    const topActions = el("div", "hobbit-top-actions");
    const searchToggle = iconButton("展开搜索", "search", "hobbit-search-toggle");
    searchToggle.setAttribute("aria-expanded", String(this.searchOpen));
    const searchWrap = el("div", "hobbit-search-wrap hobbit-search-collapsible");
    const searchIcon = el("span", "hobbit-search-icon");
    setIcon(searchIcon, "search");
    const search = document.createElement("input");
    search.className = "hobbit-search";
    search.type = "search";
    search.setAttribute("aria-label", "搜索标题、正文、标签和附件");
    search.placeholder = "搜索日记";
    search.value = this.searchText;
    search.addEventListener("input", () => {
      this.searchText = search.value;
      searchWrap.classList.toggle("has-value", Boolean(this.searchText.trim()));
      this.renderList();
    });
    const clearSearch = iconButton("清除搜索", "x", "hobbit-search-clear");
    clearSearch.addEventListener("click", () => {
      search.value = "";
      this.searchText = "";
      searchWrap.classList.remove("has-value");
      search.focus();
      this.renderList();
    });
    searchWrap.append(searchIcon, search, clearSearch);
    searchToggle.addEventListener("click", () => {
      this.searchOpen = !this.searchOpen;
      searchToggle.setAttribute("aria-expanded", String(this.searchOpen));
      searchToggle.setAttribute("aria-label", this.searchOpen ? "收起搜索" : "展开搜索");
      searchToggle.title = this.searchOpen ? "收起搜索" : "展开搜索";
      searchWrap.classList.toggle("is-open", this.searchOpen);
      if (this.searchOpen) search.focus();
    });
    searchWrap.classList.toggle("is-open", this.searchOpen);
    searchWrap.classList.toggle("has-value", Boolean(this.searchText.trim()));
    topActions.append(searchToggle, searchWrap);
    const refreshButton = iconButton("刷新", "refresh-cw");
    refreshButton.addEventListener("click", () => void this.refresh());
    topActions.appendChild(refreshButton);
    topbar.appendChild(topActions);

    const layout = el("div", "hobbit-layout");
    shell.appendChild(layout);

    const sidebar = el("aside", "hobbit-sidebar");
    layout.appendChild(sidebar);
    const statBlock = el("div", "hobbit-stat-block");
    this.statTotal = el("strong", "hobbit-stat-number", "0");
    statBlock.append(this.statTotal, el("span", "hobbit-stat-label", "篇日记"));
    sidebar.appendChild(statBlock);

    const navTitle = el("div", "hobbit-sidebar-label", "档案");
    sidebar.appendChild(navTitle);
    this.navEl = el("div", "hobbit-nav-list");
    sidebar.appendChild(this.navEl);
    for (const item of [
      ["all", "全部日记", "layout-list"],
      ["favorite", "收藏", "star"],
      ["photo", "照片", "image"],
    ]) {
      const button = navButton(item[1], item[2]);
      button.dataset.filter = item[0];
      button.addEventListener("click", () => {
        this.filter = item[0];
        this.dateFilter = null;
        this.updateNavState();
        this.renderList();
      });
      this.navEl.appendChild(button);
    }
    this.updateNavState();

    const main = el("main", "hobbit-main");
    layout.appendChild(main);

    const hero = el("section", "hobbit-hero");
    main.appendChild(hero);
    const heroCopy = el("div", "hobbit-hero-copy");
    hero.appendChild(heroCopy);
    heroCopy.appendChild(el("div", "hobbit-eyebrow", "PRIVATE ARCHIVE / TODAY"));
    this.heroTitle = el("h1", "hobbit-hero-title", "今天，留下什么？");
    heroCopy.appendChild(this.heroTitle);
    this.heroStatus = el(
      "p",
      "hobbit-hero-status",
      "你的每日档案会从这里开始。"
    );
    heroCopy.appendChild(this.heroStatus);
    const heroActions = el("div", "hobbit-hero-actions");
    this.heroPrimary = button("写今天的日记", "hobbit-primary-button", "pen-line");
    this.heroPrimary.addEventListener("click", () => {
      void this.openTodayFromHero();
    });
    heroActions.appendChild(this.heroPrimary);
    this.heroSecondary = button("查看今天", "hobbit-quiet-button", "arrow-up-right");
    this.heroSecondary.addEventListener("click", () => {
      const today = this.entries.find((entry) => entry.date === localDateKey(new Date()));
      if (today) void this.plugin.openDiary(today.file.path);
    });
    heroActions.appendChild(this.heroSecondary);
    heroCopy.appendChild(heroActions);

    const heroMark = el("div", "hobbit-hero-mark");
    heroMark.appendChild(el("span", "hobbit-hero-date", formatMonthDay(localDateKey(new Date()))));
    heroMark.appendChild(el("span", "hobbit-hero-word", "记下今天"));
    hero.appendChild(heroMark);

    const listHeader = el("div", "hobbit-list-header");
    const listHeading = el("div", "hobbit-list-heading");
    listHeading.appendChild(el("span", "hobbit-eyebrow", "YOUR DAYS"));
    const listTitleRow = el("div", "hobbit-section-title-row");
    this.listTitle = el("h2", "hobbit-section-title", "全部日记");
    listTitleRow.appendChild(this.listTitle);
    this.calendarToggle = iconButton("打开日历", "calendar-days", "hobbit-calendar-icon-button");
    this.calendarToggle.setAttribute("aria-expanded", "false");
    this.calendarToggle.setAttribute("aria-controls", "hobbit-calendar-panel");
    this.calendarToggle.addEventListener("click", () => {
      this.calendarOpen = !this.calendarOpen;
      this.renderCalendar();
    });
    listTitleRow.appendChild(this.calendarToggle);
    listHeading.appendChild(listTitleRow);
    listHeader.appendChild(listHeading);
    this.countEl = el("span", "hobbit-list-count", "0 篇");
    listHeader.appendChild(this.countEl);
    main.appendChild(listHeader);

    this.calendarEl = el("div", "hobbit-calendar-panel hobbit-calendar-popover");
    this.calendarEl.id = "hobbit-calendar-panel";
    main.appendChild(this.calendarEl);

    this.dateFilterEl = el("button", "hobbit-date-filter");
    this.dateFilterEl.addEventListener("click", () => {
      this.dateFilter = null;
      this.renderList();
    });
    main.appendChild(this.dateFilterEl);

    this.listEl = el("div", "hobbit-entry-list");
    main.appendChild(this.listEl);
  }

  async openTodayFromHero() {
    const today = this.entries.find((entry) => entry.date === localDateKey(new Date()));
    if (today) {
      await this.plugin.openNativeEditor(today.file);
      return;
    }
    await this.plugin.createTodayDiary();
  }

  updateHero() {
    if (!this.heroStatus) return;
    const today = this.entries.find((entry) => entry.date === localDateKey(new Date()));
    if (today) {
      const generatedHeading =
        isGeneratedDiaryHeading(today.body, today.date) ||
        today.title === `${formatLongDate(today.date)} ${weekdayFor(today.date)}`;
      this.heroTitle.textContent = generatedHeading
        ? formatLongDate(today.date)
        : today.title;
      this.heroStatus.textContent = "今天的档案已经打开，继续写下去。";
      this.heroPrimary.replaceChildren();
      setIcon(this.heroPrimary, "edit-3");
      this.heroPrimary.appendChild(document.createTextNode("继续编辑今天"));
      this.heroSecondary.classList.remove("is-hidden");
    } else {
      this.heroTitle.textContent = "今天，留下什么？";
      this.heroStatus.textContent = "你的每日档案会从这里开始。";
      this.heroPrimary.replaceChildren();
      setIcon(this.heroPrimary, "pen-line");
      this.heroPrimary.appendChild(document.createTextNode("写今天的日记"));
      this.heroSecondary.classList.add("is-hidden");
    }
    this.statTotal.textContent = String(this.entries.length);
  }

  updateNavState() {
    if (!this.navEl) return;
    for (const item of this.navEl.querySelectorAll("[data-filter]")) {
      item.classList.toggle("is-active", item.dataset.filter === this.filter);
    }
  }

  renderCalendar() {
    if (!this.calendarEl) return;
    this.calendarEl.replaceChildren();
    this.calendarEl.classList.toggle("is-open", this.calendarOpen);
    const calendarLabel = this.calendarOpen ? "关闭日历" : "打开日历";
    this.calendarToggle?.setAttribute("aria-expanded", String(this.calendarOpen));
    this.calendarToggle?.setAttribute("aria-label", calendarLabel);
    if (this.calendarToggle) this.calendarToggle.title = calendarLabel;
    if (!this.calendarOpen) return;

    const year = this.calendarDate.getFullYear();
    const month = this.calendarDate.getMonth();
    const header = el("div", "hobbit-calendar-header");
    const prev = iconButton("上个月", "chevron-left");
    prev.addEventListener("click", () => {
      this.calendarDate = new Date(year, month - 1, 1);
      this.renderCalendar();
    });
    const next = iconButton("下个月", "chevron-right");
    next.addEventListener("click", () => {
      this.calendarDate = new Date(year, month + 1, 1);
      this.renderCalendar();
    });
    header.append(
      prev,
      el("span", "hobbit-calendar-month", `${year}年${month + 1}月`),
      next
    );
    this.calendarEl.appendChild(header);

    const weekdays = el("div", "hobbit-calendar-weekdays");
    for (const day of ["一", "二", "三", "四", "五", "六", "日"]) {
      weekdays.appendChild(el("span", "hobbit-calendar-weekday", day));
    }
    this.calendarEl.appendChild(weekdays);

    const grid = el("div", "hobbit-calendar-grid");
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const diaryDates = new Set(this.entries.map((entry) => entry.date));
    for (let i = 0; i < offset; i++) grid.appendChild(el("span", "hobbit-calendar-empty"));
    for (let day = 1; day <= days; day++) {
      const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const cell = document.createElement("button");
      cell.className = "hobbit-calendar-day";
      cell.textContent = String(day);
      cell.title = date;
      if (diaryDates.has(date)) cell.classList.add("has-diary");
      if (date === localDateKey(new Date())) cell.classList.add("is-today");
      if (date === this.dateFilter) cell.classList.add("is-selected");
      cell.addEventListener("click", async () => {
        const entry = this.entries.find((item) => item.date === date);
        if (entry) {
          this.calendarOpen = false;
          this.renderCalendar();
          void this.plugin.openDiary(entry.file.path);
        } else {
          const shouldCreate = await this.plugin.confirmCreateDiary(date);
          if (!shouldCreate) return;
          this.calendarOpen = false;
          this.renderCalendar();
          void this.plugin.createDiaryForDate(date);
        }
      });
      grid.appendChild(cell);
    }
    this.calendarEl.appendChild(grid);
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    let items = this.entries;
    if (this.filter === "favorite") items = items.filter((entry) => entry.favorite);
    if (this.filter === "photo") items = items.filter((entry) => entry.images.length > 0);
    if (this.dateFilter) items = items.filter((entry) => entry.date === this.dateFilter);

    const query = this.searchText.trim().toLowerCase();
    if (query) {
      items = items.filter((entry) => {
        const haystack = [
          entry.title,
          entry.preview,
          entry.date,
          ...entry.tags,
          ...entry.images.flatMap((image) => getImageSearchTerms(image)),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });
    }

    const filterNames = { all: "全部日记", favorite: "收藏", photo: "照片" };
    this.listTitle.textContent = this.dateFilter
      ? `${this.dateFilter} 的日记`
      : filterNames[this.filter];
    this.countEl.textContent = `${items.length} 篇`;
    this.dateFilterEl.textContent = this.dateFilter ? `仅显示 ${this.dateFilter}  ×` : "";
    this.dateFilterEl.classList.toggle("is-visible", Boolean(this.dateFilter));

    if (items.length === 0) {
      const empty = el("div", "hobbit-empty-state");
      const icon = el("div", "hobbit-empty-icon");
      setIcon(icon, this.entries.length === 0 ? "feather" : "search-x");
      empty.appendChild(icon);
      empty.appendChild(
        el(
          "h3",
          "hobbit-empty-title",
          this.entries.length === 0 ? "这里还没有日记" : "没有找到这样的日记"
        )
      );
      empty.appendChild(
        el(
          "p",
          "hobbit-empty-text",
          this.entries.length === 0
            ? "从今天开始，给自己留下一页私人档案。"
            : "试试换一个关键词或筛选条件。"
        )
      );
      if (this.entries.length === 0) {
        const start = button("写今天的日记", "hobbit-primary-button", "pen-line");
        start.addEventListener("click", () => void this.plugin.createTodayDiary());
        empty.appendChild(start);
      }
      this.listEl.appendChild(empty);
      return;
    }

    for (const entry of items) {
      this.listEl.appendChild(this.renderEntryCard(entry));
    }
  }

  renderEntryCard(entry) {
    const card = el("article", "hobbit-entry-card");
    card.classList.toggle("has-media", entry.images.length > 0);
    card.tabIndex = 0;
    card.addEventListener("click", () => void this.plugin.openDiary(entry.file.path));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.plugin.openDiary(entry.file.path);
      }
    });

    const dateBlock = el("div", "hobbit-entry-date");
    dateBlock.appendChild(el("strong", "hobbit-entry-day", dayNumber(entry.date)));
    dateBlock.appendChild(el("span", "hobbit-entry-month", monthLabel(entry.date)));
    dateBlock.appendChild(el("span", "hobbit-entry-weekday", weekdayFor(entry.date)));
    dateBlock.appendChild(
      el("span", "hobbit-entry-updated", `更新 ${formatTime(entry.file.stat.mtime)}`)
    );
    card.appendChild(dateBlock);

    const content = el("div", "hobbit-entry-content");
    const titleRow = el("div", "hobbit-entry-title-row");
    titleRow.appendChild(el("h3", "hobbit-entry-title", entry.title));
    const favorite = iconButton(
      entry.favorite ? "取消收藏" : "收藏",
      "star",
      entry.favorite ? "is-active" : ""
    );
    favorite.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    favorite.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.plugin.setFavorite(entry.file, !entry.favorite);
    });
    titleRow.appendChild(favorite);
    content.appendChild(titleRow);
    content.appendChild(el("p", "hobbit-entry-preview", entry.preview || "这一天还没有文字。"));
    if (entry.tags.length) {
      const tags = el("div", "hobbit-entry-tags");
      for (const tag of entry.tags.slice(0, 4)) tags.appendChild(el("span", "hobbit-tag", `#${tag}`));
      content.appendChild(tags);
    }
    card.appendChild(content);

    if (entry.images.length) {
      const visibleImages = entry.images.slice(0, 4);
      const media = el("div", "hobbit-entry-media");
      media.classList.add(`is-count-${visibleImages.length}`);
      media.dataset.imageCount = String(visibleImages.length);
      appendImageGallery(
        media,
        visibleImages,
        this.plugin,
        entry.file.path,
        "hobbit-entry-image-button"
      );
      if (entry.images.length > 4) {
        media.appendChild(el("span", "hobbit-more-images", `+${entry.images.length - 4}`));
      }
      card.appendChild(media);
    }
    return card;
  }
}

class HobbitDiaryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.path = null;
  }

  getViewType() {
    return DIARY_VIEW_TYPE;
  }

  getDisplayText() {
    return "Hobbit 日记";
  }

  getIcon() {
    return "mountain";
  }

  getState() {
    return { path: this.path };
  }

  async setState(state, result) {
    this.path = state?.path || null;
    await this.render();
    if (result) result();
  }

  async onOpen() {
    await this.render();
  }

  async onClose() {
    this.contentEl.replaceChildren();
  }

  async refresh() {
    if (this.path) await this.render();
  }

  async render() {
    this.contentEl.replaceChildren();
    this.contentEl.className = "view-content hobbit-view-content";
    const file = this.plugin.app.vault.getAbstractFileByPath(this.path || "");
    if (!(file instanceof TFile)) {
      this.contentEl.appendChild(el("div", "hobbit-reader-missing", "找不到这篇日记"));
      return;
    }

    const raw = await this.plugin.app.vault.cachedRead(file);
    const frontmatter = this.plugin.getFrontmatter(file, raw);
    const body = stripFrontmatter(raw);
    const date = this.plugin.getDailyNoteDate(file);
    if (!date) {
      this.contentEl.appendChild(el("div", "hobbit-reader-missing", "这篇笔记不符合当前核心日记设置"));
      return;
    }
    const title = cleanText(frontmatter.title) || extractHeading(body) || formatLongDate(date);
    const entries = await this.plugin.getDiaryEntries();
    const index = entries.findIndex((entry) => entry.file.path === file.path);
    const previous = index >= 0 ? entries[index + 1] : null;
    const next = index > 0 ? entries[index - 1] : null;
    const images = this.plugin.resolveImages(raw, file);
    const favorite = frontmatter.favorite === true || frontmatter.favorite === "true";

    const shell = el("div", "hobbit-reader-shell");
    this.contentEl.appendChild(shell);

    const reader = el("article", "hobbit-reader");
    shell.appendChild(reader);
    const header = el("header", "hobbit-reader-header");
    header.appendChild(el("div", "hobbit-eyebrow", "A PAGE FROM YOUR LIFE"));
    header.appendChild(el("h1", "hobbit-reader-title", title));
    header.appendChild(el("div", "hobbit-reader-date", `${formatLongDate(date)} ${weekdayFor(date)}`));
    if (images.length) {
      header.appendChild(el("div", "hobbit-reader-photo-count", `${images.length} 张照片`));
    }

    const actionBar = el("div", "hobbit-reader-actions");
    const home = iconButton("返回 Hobbit 主页", "home", "hobbit-reader-action-button");
    home.addEventListener("click", () => void this.plugin.activateHome());
    actionBar.appendChild(home);

    const edit = iconButton("进入编辑", "edit-3", "hobbit-reader-action-button");
    edit.addEventListener("click", () => void this.plugin.openNativeEditor(file));
    actionBar.appendChild(edit);
    const addPhoto = iconButton("添加照片", "image-plus", "hobbit-reader-action-button");
    const photoInput = document.createElement("input");
    photoInput.type = "file";
    photoInput.accept = "image/*";
    photoInput.multiple = true;
    photoInput.className = "hobbit-hidden-input";
    photoInput.addEventListener("change", () => {
      const selectedFiles = Array.from(photoInput.files || []);
      void (async () => {
        for (const selected of selectedFiles) {
          await this.plugin.addPhoto(file, selected);
        }
      })();
      photoInput.value = "";
    });
    addPhoto.addEventListener("click", () => photoInput.click());
    actionBar.append(addPhoto, photoInput);
    const addTag = iconButton("添加标签", "tag", "hobbit-reader-action-button");
    addTag.addEventListener("click", () => {
      const value = window.prompt("输入标签，不需要输入 #");
      if (value) void this.plugin.addTag(file, value);
    });
    actionBar.appendChild(addTag);
    const favoriteButton = iconButton(
      favorite ? "取消收藏" : "收藏",
      "star",
      "hobbit-reader-action-button"
    );
    favoriteButton.classList.toggle("is-active", favorite);
    favoriteButton.addEventListener("click", () => {
      void this.plugin.setFavorite(file, !favorite);
    });
    actionBar.appendChild(favoriteButton);
    header.appendChild(actionBar);
    reader.appendChild(header);

    if (frontmatter.tags || collectTags(frontmatter, body).length) {
      const tags = el("div", "hobbit-reader-tags");
      for (const tag of collectTags(frontmatter, body)) tags.appendChild(el("span", "hobbit-tag", `#${tag}`));
      reader.appendChild(tags);
    }

    const articleBody = el("div", "hobbit-reader-body markdown-preview-view");
    reader.appendChild(articleBody);
    const renderBody = prepareReaderBody(body, this.plugin, file);
    await MarkdownRenderer.renderMarkdown(renderBody, articleBody, file.path, this);
    attachRenderedImageInteractions(articleBody, this.plugin);

    const navigation = el("nav", "hobbit-reader-navigation");
    const previousButton = button(
      previous ? formatMonthDay(previous.date) : "没有更早的日记",
      "hobbit-nav-day-button",
      "arrow-left"
    );
    previousButton.classList.add("is-previous");
    previousButton.disabled = !previous;
    previousButton.addEventListener("click", () => {
      if (previous) void this.plugin.openDiary(previous.file.path);
    });
    const nextButton = button(
      next ? formatMonthDay(next.date) : "没有更新的日记",
      "hobbit-nav-day-button",
      "arrow-right"
    );
    nextButton.classList.add("is-next");
    nextButton.disabled = !next;
    nextButton.addEventListener("click", () => {
      if (next) void this.plugin.openDiary(next.file.path);
    });
    navigation.append(previousButton, nextButton);
    reader.appendChild(navigation);
  }
}

class HobbitSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.replaceChildren();
    containerEl.appendChild(el("h2", "hobbit-settings-title", "Hobbit 日记"));
    containerEl.appendChild(
      el(
        "p",
        "hobbit-settings-intro",
        "Hobbit 的日记来源完全跟随 Obsidian 核心插件“日记”的设置；模板和 frontmatter 不需要配合 Hobbit。"
      )
    );
    const source = this.plugin.getDailyNotesSource();
    containerEl.appendChild(
      el(
        "p",
        "hobbit-settings-source",
        source
          ? `当前识别规则：${source.folderPath || "核心插件默认位置"} · ${source.format}`
          : "当前未检测到已启用的核心插件“日记”。"
      )
    );
    new Setting(containerEl)
      .setName("附件文件夹")
      .setDesc("通过 Hobbit 添加的照片会保存到这里。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.attachmentFolder)
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentFolder = value.trim() || DEFAULT_SETTINGS.attachmentFolder;
            await this.plugin.saveSettings();
          })
      );
  }
}

function setHobbitCaveIcon(node) {
  if (!node) return node;
  const svg = node.querySelector("svg") || document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.55");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("svg-icon", "hobbit-cave-icon");
  svg.innerHTML = `
    <path d="M3.2 19.5c.75-5.65 4.05-9.65 8.8-9.65s8.05 4 8.8 9.65" />
    <path d="M3.2 19.5h17.6" />
    <path d="M7.7 19.5v-2.35a4.3 4.3 0 0 1 8.6 0v2.35" />
    <path d="M12 14.35V19.5" />
    <circle cx="13.45" cy="17.15" r="0.42" fill="currentColor" stroke="none" />
    <path d="M5.2 16.1l-1.35-1.25m14.95 1.25l1.35-1.25" />
  `;
  if (!svg.parentElement) node.replaceChildren(svg);
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, icon) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  if (icon) {
    const iconEl = el("span", "hobbit-button-icon");
    setIcon(iconEl, icon);
    node.appendChild(iconEl);
  }
  node.appendChild(document.createTextNode(text));
  return node;
}

function iconButton(label, icon, extraClass = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `hobbit-icon-button ${extraClass}`.trim();
  node.setAttribute("aria-label", label);
  node.title = label;
  setIcon(node, icon);
  return node;
}

function navButton(text, icon) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "hobbit-nav-button";
  const iconEl = el("span", "hobbit-nav-icon");
  setIcon(iconEl, icon);
  node.append(iconEl, el("span", "hobbit-nav-text", text));
  return node;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    result[key] = parseYamlValue(value);
  }
  return result;
}

function parseYamlValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
      .filter(Boolean);
  }
  return value.replace(/^['\"]|['\"]$/g, "");
}

function stripFrontmatter(raw) {
  return raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

function removeFirstHeading(body) {
  return body.replace(/^\s*#\s+[^\r\n]+\r?\n?/, "");
}

function removeInlineTags(body) {
  return body
    .replace(/^\s*(?:#[^\s#，。！？、；：]+\s*)+$/gm, "")
    .replace(/(^|[\s\u3000，。！？、；：])#[^\s#，。！？、；：]+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function prepareReaderBody(body, plugin, sourceFile) {
  // Navigation links and task markers are editing metadata, not diary prose.
  const withoutEditingMetadata = body
    .replace(/^\s*[-*+]\s*\[[^\]]*\]\s*\[\[[^\]]+\]\]\s*$/gm, "")
    .replace(/^\s*[-*+]\s*\[[^\]]*\]\s+/gm, "");
  const cleaned = removeInlineTags(removeFirstHeading(withoutEditingMetadata));
  return normalizeReaderImageEmbeds(cleaned, plugin, sourceFile);
}

function normalizeReaderImageEmbeds(body, plugin, sourceFile) {
  return body.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (whole, rawTarget) => {
    const target = cleanImageTarget(rawTarget);
    if (!target) return "";
    if (/^(https?:|data:)/i.test(target)) {
      return `![日记照片](${target})`;
    }
    const destination = plugin.app.metadataCache.getFirstLinkpathDest(
      target,
      sourceFile.path
    );
    if (!(destination instanceof TFile) || !IMAGE_EXTENSIONS.has(destination.extension.toLowerCase())) {
      return "";
    }
    const source = plugin.app.vault.getResourcePath(destination);
    return `![日记照片](${source})`;
  });
}

function cleanImageTarget(value) {
  let target = String(value || "").trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  const titled = target.match(/^(\S+)\s+(?:["'][^]*["']|\([^)]*\))$/);
  return (titled ? titled[1] : target).trim();
}

function getImageSource(image, app) {
  if (image instanceof TFile) return app.vault.getResourcePath(image);
  if (typeof image === "string") return image;
  if (image && typeof image.src === "string") return image.src;
  if (image?.file instanceof TFile) return app.vault.getResourcePath(image.file);
  return "";
}

function getImageSearchTerms(image) {
  if (image instanceof TFile) return [image.basename, image.path];
  if (typeof image === "string") return [image];
  return [image?.name || "", image?.path || "", image?.src || ""];
}

function attachRenderedImageInteractions(container, plugin) {
  for (const image of Array.from(container.querySelectorAll("img"))) {
    image.alt = "日记照片";
    image.loading = "lazy";
    image.decoding = "async";
    image.tabIndex = 0;
    image.classList.add("hobbit-inline-image");
    image.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void plugin.openImage(image.currentSrc || image.src);
    });
    image.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void plugin.openImage(image.currentSrc || image.src);
    });
    image.addEventListener("error", () => {
      image.classList.add("is-broken");
      image.closest(".internal-embed, .image-embed")?.classList.add("is-broken");
    });
  }
}

function appendImageGallery(container, images, plugin, sourcePath, buttonClass) {
  images.forEach((image, index) => {
    const source = getImageSource(image, plugin.app);
    if (!source) return;
    const imageButton = document.createElement("button");
    imageButton.type = "button";
    imageButton.className = buttonClass;
    imageButton.setAttribute("aria-label", `查看第 ${index + 1} 张日记照片`);
    imageButton.title = "查看大图";
    imageButton.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    imageButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void plugin.openImage(image, sourcePath);
    });
    const img = document.createElement("img");
    img.src = source;
    img.alt = "日记照片";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      imageButton.remove();
      syncEntryMediaCount(container);
      if (!container.querySelector("img")) {
        container.closest(".hobbit-entry-card")?.classList.remove("has-media");
        container.remove();
      }
    });
    imageButton.appendChild(img);
    container.appendChild(imageButton);
  });
}

function syncEntryMediaCount(container) {
  const count = Math.min(4, container.querySelectorAll(".hobbit-entry-image-button").length);
  for (let index = 1; index <= 4; index += 1) {
    container.classList.toggle(`is-count-${index}`, count === index);
  }
  container.dataset.imageCount = String(count);
}

function extractHeading(body) {
  const match = body.match(/^\s*#\s+(.+)$/m);
  return match ? cleanText(match[1]) : "";
}

function isGeneratedDiaryHeading(body, date) {
  const heading = extractHeading(body);
  if (!heading || !date) return false;
  return [
    `${formatLongDate(date)} ${weekdayFor(date)}`,
    formatLongDate(date),
    date,
  ].includes(heading);
}

function countWords(body) {
  const value = body
    .replace(/!\[\[[^\]]+\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[`*_~>#-]/g, " ")
    .trim();
  if (!value) return 0;
  const cjk = value.match(/[\u3400-\u9fff]/g)?.length || 0;
  const latin = value
    .replace(/[\u3400-\u9fff]/g, " ")
    .match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length || 0;
  return cjk + latin;
}

function makePreview(body, title) {
  let inFence = false;
  let inListContinuation = false;
  const proseLines = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const isListItem = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/.test(line);
    if (isListItem) {
      inListContinuation = true;
      continue;
    }
    if (inListContinuation && /^\s{2,}\S/.test(line)) continue;
    inListContinuation = false;
    if (/^\s*#{1,6}\s+/.test(line)) continue;
    if (/^\s*(?:#[^\s#，。！？、；：]+\s*)+$/.test(line)) continue;
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) continue;
    proseLines.push(line.replace(/^\s*>\s?/, ""));
  }

  let value = proseLines.join("\n")
    .replace(/^\s*#\s+[^\r\n]+\r?\n?/m, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|[\s\u3000，。！？、；：])#[^\s#，。！？、；：]+/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value === title) value = "";
  return value.slice(0, 180) + (value.length > 180 ? "…" : "");
}

function collectTags(frontmatter, body) {
  const result = normalizeTags(frontmatter.tags);
  const inline = body.match(/(^|\s)#([^\s#]+)/gm) || [];
  for (const item of inline) {
    const tag = item.trim().replace(/^#/, "");
    if (tag && !result.includes(tag)) result.push(tag);
  }
  return result;
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.replace(/^#/, "")).filter(Boolean);
  if (typeof value === "string") return value.split(/[ ,]+/).map((tag) => tag.replace(/^#/, "")).filter(Boolean);
  return [];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatLongDate(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function formatMonthDay(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function weekdayFor(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return date.toLocaleDateString("zh-CN", { weekday: "long" });
}

function dayNumber(dateKey) {
  return String(Number(dateKey.slice(8, 10)));
}

function monthLabel(dateKey) {
  return `${dateKey.slice(0, 4)} / ${dateKey.slice(5, 7)}`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extensionFromName(name) {
  const match = name.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function sanitizeFilename(value) {
  return value.replace(/[\\/:*?\"<>|]/g, "-").replace(/\s+/g, "-").slice(0, 80);
}

module.exports = HobbitPlugin;

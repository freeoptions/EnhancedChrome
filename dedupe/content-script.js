(() => {
  const extensionRuntime = globalThis.chrome?.runtime;
  const initialValueMap = new WeakMap();
  let lastState = "";
  let reportTimer = null;
  let toastElement = null;
  let monitoringEnabled = false;
  extensionRuntime && chrome.storage.local.get('enhancedSettings').then(storage => {
    monitoringEnabled = storage.enhancedSettings?.dedupeEnabled !== false;
    if (monitoringEnabled) scheduleReport();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enhancedSettings) return;
    monitoringEnabled = changes.enhancedSettings.newValue?.dedupeEnabled !== false;
    lastState = '';
    if (monitoringEnabled) scheduleReport();
  });

  function showToast(message) {
    toastElement?.remove();
    toastElement = document.createElement("div");
    toastElement.textContent = message;
    toastElement.style.cssText = [
      "all: initial",
      "position: fixed !important",
      "top: 20px !important",
      "right: 20px !important",
      "z-index: 2147483647 !important",
      "max-width: 360px !important",
      "padding: 10px 14px !important",
      "border: 1px solid rgba(255,255,255,.2) !important",
      "border-radius: 10px !important",
      "background: rgba(24, 32, 51, .94) !important",
      "box-shadow: 0 8px 26px rgba(0,0,0,.2) !important",
      "color: #fff !important",
      "font: 14px/1.5 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif !important",
      "opacity: 0 !important",
      "transform: translateY(-6px) !important",
      "transition: opacity .18s ease, transform .18s ease !important"
    ].join(";");
    document.documentElement.append(toastElement);
    requestAnimationFrame(() => {
      if (!toastElement) {
        return;
      }
      toastElement.style.setProperty("opacity", "1", "important");
      toastElement.style.setProperty("transform", "translateY(0)", "important");
    });
    setTimeout(() => {
      if (!toastElement) {
        return;
      }
      toastElement.style.setProperty("opacity", "0", "important");
      toastElement.style.setProperty("transform", "translateY(-6px)", "important");
      setTimeout(() => {
        toastElement?.remove();
        toastElement = null;
      }, 220);
    }, 1800);
  }

  if (typeof extensionRuntime?.onMessage?.addListener === "function") {
    extensionRuntime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "SHOW_DEDUPE_TOAST" && document.documentElement) {
        showToast(String(message.message || "已处理重复标签页"));
        sendResponse({ ok: true });
      }
    });
  }

  function getEditableElements() {
    return document.querySelectorAll(
      "input:not([type=\"hidden\"]):not([type=\"submit\"]):not([type=\"button\"]):not([type=\"reset\"]), textarea, select, [contenteditable=\"true\"], [contenteditable=\"\"]"
    );
  }

  function rememberInitialValues() {
    if (!monitoringEnabled) return;
    for (const element of getEditableElements()) {
      if (initialValueMap.has(element)) {
        continue;
      }

      if (element.matches("[contenteditable=\"true\"], [contenteditable=\"\"]")) {
        initialValueMap.set(element, {
          type: "contenteditable",
          value: element.textContent || ""
        });
      } else if (element instanceof HTMLSelectElement) {
        initialValueMap.set(element, {
          type: "select",
          value: [...element.options].map((option) => option.defaultSelected)
        });
      } else if (element instanceof HTMLInputElement) {
        initialValueMap.set(element, {
          type: element.type,
          value: element.type === "checkbox" || element.type === "radio"
            ? element.defaultChecked
            : element.defaultValue
        });
      } else {
        initialValueMap.set(element, {
          type: "textarea",
          value: element.defaultValue
        });
      }
    }
  }

  function isElementDirty(element) {
    const initial = initialValueMap.get(element);
    if (!initial) {
      return false;
    }

    if (initial.type === "contenteditable") {
      return (element.textContent || "") !== initial.value;
    }
    if (initial.type === "select") {
      return [...element.options].some(
        (option, index) => option.selected !== initial.value[index]
      );
    }
    if (initial.type === "checkbox" || initial.type === "radio") {
      return element.checked !== initial.value;
    }
    if (initial.type === "file") {
      return element.files?.length > 0;
    }
    return element.value !== initial.value;
  }

  function calculateState() {
    rememberInitialValues();
    const editableCount = getEditableElements().length;
    const dirty = [...getEditableElements()].some(isElementDirty);
    const hasBeforeUnloadHandler = typeof window.onbeforeunload === "function";
    return { dirty, editableCount, hasBeforeUnloadHandler };
  }

  function reportState() {
    if (!monitoringEnabled) return;
    const state = calculateState();
    const serialized = JSON.stringify(state);
    if (serialized === lastState) {
      return;
    }
    lastState = serialized;
    if (typeof extensionRuntime?.sendMessage !== "function") {
      return;
    }

    try {
      const response = extensionRuntime.sendMessage({
        type: "PAGE_PROTECTION_STATE",
        url: location.href,
        ...state
      });
      response?.catch?.(() => {});
    } catch {
      // 扩展被重新加载或卸载后，旧页面中的 content script 可能失去运行时上下文。
    }
  }

  function scheduleReport() {
    if (!monitoringEnabled) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(reportState, 80);
  }

  document.addEventListener("input", scheduleReport, true);
  document.addEventListener("change", scheduleReport, true);
  document.addEventListener("reset", () => setTimeout(reportState, 0), true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportState, { once: true });
  } else {
    reportState();
  }

  function observeDom() {
    if (!document.documentElement) {
      return;
    }
    const observer = new MutationObserver(() => {
      rememberInitialValues();
      scheduleReport();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["contenteditable"]
    });
  }

  if (document.documentElement) {
    observeDom();
  } else {
    document.addEventListener("DOMContentLoaded", observeDom, { once: true });
  }
})();

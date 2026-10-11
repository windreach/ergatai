import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DockviewApi, DockviewComponent, themeDark, themeLight } from "dockview";
import type {
  CreateComponentOptions,
  GroupPanelPartInitParameters,
  IHeaderActionsRenderer,
  IContentRenderer,
  ITabGroup,
  ITabGroupChipRenderer,
  ITabRenderer,
  Parameters as DockviewParameters,
} from "dockview";
import "dockview/dist/styles/dockview.css";

import { panels, tabTypes } from "@/panels/registry";
import { isTabAllowedInDomain } from "@/stores/tabs";
import type { LayoutDomain, Tab, TabType, UseLayoutStore } from "@/stores/tabs";
import { ErrorBoundary } from "@/components/ErrorBoundary";

interface NewTabOption {
  type: TabType;
  label: string;
  singleInstance?: boolean;
}

interface TabGroupLabels {
  groupWithLabel: string;
  ungroupLabel: string;
  tabGroupLabel: string;
  closeTabLabel: string;
  renameGroupLabel: string;
  groupColorLabel: string;
  collapseGroupLabel: string;
  expandGroupLabel: string;
  closeGroupLabel: string;
}

interface DockviewTabsProps {
  useStore: UseLayoutStore;
  domain: LayoutDomain;
  ariaLabel: string;
  titleForTab: (type: TabType) => string;
  emptyLabel: string;
  emptyState?: (createTab: (type: TabType) => void) => ReactNode;
  newTabLabel: string;
  newTabs: NewTabOption[];
  openNewTab: (type: TabType) => string | null;
  groupWithLabel: string;
  ungroupLabel: string;
  tabGroupLabel: string;
  closeTabLabel: string;
  renameGroupLabel: string;
  groupColorLabel: string;
  collapseGroupLabel: string;
  expandGroupLabel: string;
  closeGroupLabel: string;
  leadingAction?: ReactNode;
  toolbarAction?: ReactNode;
  trailingAction?: ReactNode;
}

function isTabType(value: string): value is TabType {
  return tabTypes.includes(value as TabType);
}

const dockviewThemes = {
  dark: themeDark,
  light: themeLight,
} as const;

function createHeaderActionRenderer(content: ReactNode): IHeaderActionsRenderer {
  const element = document.createElement("div");
  element.className = content ? "dockview-header-action" : "dockview-header-action dockview-header-action-empty";
  const root = createRoot(element);
  root.render(content);

  return {
    element,
    init: () => {},
    dispose: () => {
      queueMicrotask(() => root.unmount());
    },
  };
}

function createNewTabAction(propsRef: RefObject<{
  availableNewTabs: NewTabOption[];
  newTabLabel: string;
  openNewTab: (type: TabType) => string | null;
}>): IHeaderActionsRenderer {
  const element = document.createElement("div");
  element.className = "dockview-header-action";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dockview-header-action-button";
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
  element.appendChild(button);

  let menu: HTMLDivElement | null = null;

  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  }

  function handleOutsidePointerDown(event: PointerEvent) {
    if (!menu || event.target instanceof Node && element.contains(event.target)) return;
    closeMenu();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") closeMenu();
  }

  function openMenu() {
    const { availableNewTabs } = propsRef.current;
    menu = document.createElement("div");
    menu.className = "dockview-header-action-menu";

    availableNewTabs.forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "dockview-header-action-menu-item";
      item.textContent = option.label;
      item.addEventListener("click", () => {
        propsRef.current.openNewTab(option.type);
        closeMenu();
      });
      menu?.appendChild(item);
    });

    element.appendChild(menu);
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
  }

  button.addEventListener("click", () => {
    if (menu) closeMenu();
    else openMenu();
  });

  return {
    element,
    init: () => {
      const { newTabLabel } = propsRef.current;
      button.setAttribute("aria-label", newTabLabel);
      button.setAttribute("title", newTabLabel);
    },
    dispose: closeMenu,
  };
}

function createPanelContentRenderer({ name }: CreateComponentOptions): IContentRenderer {
  const element = document.createElement("div");
  element.className = "dockview-panel-content";
  const tabType = isTabType(name) ? name : null;
  let root: Root | null = null;
  let params: DockviewParameters = {};

  function render() {
    if (!tabType) return;
    const conversationId = typeof params.conversationId === "string"
      ? params.conversationId
      : undefined;
    const Panel = panels[tabType].component;
    root ??= createRoot(element);
    root.render(
      <ErrorBoundary>
        <Suspense fallback={<div className="h-full w-full bg-surface" />}>
          <Panel conversationId={conversationId} />
        </Suspense>
      </ErrorBoundary>,
    );
  }

  return {
    element,
    init: (initialParameters: GroupPanelPartInitParameters) => {
      params = initialParameters.params ?? {};
      render();
    },
    update: (event) => {
      params = { ...params, ...event.params };
      render();
    },
    dispose: () => {
      const currentRoot = root;
      root = null;
      if (currentRoot) {
        queueMicrotask(() => currentRoot.unmount());
      }
    },
  };
}

function isStoreGroupColor(value: unknown): value is "blue" | "purple" {
  return value === "blue" || value === "purple";
}

function getStoreGroupId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const storeGroupId = (value as Record<string, unknown>).storeGroupId;
  return typeof storeGroupId === "string" ? storeGroupId : null;
}

function getNativeTabGroup(api: DockviewApi, dockGroupId: string, storeGroupId: string) {
  return api.getTabGroups({ groupId: dockGroupId }).find((tabGroup) => (
    getStoreGroupId(tabGroup.componentParams) === storeGroupId
  ));
}

function createNativeTabRenderer({
  useStore,
  labelsRef,
}: {
  useStore: UseLayoutStore;
  labelsRef: RefObject<TabGroupLabels>;
}): ITabRenderer {
  const element = document.createElement("div");
  element.className = "ergatai-native-tab";
  const content = document.createElement("div");
  content.className = "ergatai-native-tab-title";
  const action = document.createElement("button");
  action.type = "button";
  action.className = "ergatai-native-tab-close";
  action.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  element.append(content, action);

  let parameters: GroupPanelPartInitParameters | null = null;
  let titleDisposable: { dispose: () => void } | null = null;
  let menu: HTMLDivElement | null = null;

  function render() {
    const title = parameters?.title;
    if (content.textContent !== title) content.textContent = title ?? "";
    action.setAttribute("aria-label", labelsRef.current.closeTabLabel);
    action.setAttribute("title", labelsRef.current.closeTabLabel);
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  }

  function handleOutsidePointerDown(event: PointerEvent) {
    if (!menu || event.target instanceof Node && element.contains(event.target)) return;
    closeMenu();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") closeMenu();
  }

  function addMenuItem(label: string, onClick: () => void) {
    if (!menu) return;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dockview-header-action-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      onClick();
      closeMenu();
    });
    menu.appendChild(item);
  }

  function handleContextMenu(event: MouseEvent) {
    const currentParameters = parameters;
    if (!currentParameters) return;

    const state = useStore.getState();
    const sourceTab = state.tabs.find((tab) => tab.id === currentParameters.api.id);
    if (!sourceTab) return;

    const currentPanel = currentParameters.containerApi.getPanel(sourceTab.id);
    if (!currentPanel) return;

    const candidates = state.tabs.filter((tab) => {
      if (tab.id === sourceTab.id) return false;
      if (sourceTab.visualGroupId && tab.visualGroupId === sourceTab.visualGroupId) return false;
      const panel = currentParameters.containerApi.getPanel(tab.id);
      return panel?.group.id === currentPanel.group.id;
    });

    if (!sourceTab.visualGroupId && candidates.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    closeMenu();

    menu = document.createElement("div");
    menu.className = "dockview-tab-menu";

    if (sourceTab.visualGroupId) {
      addMenuItem(labelsRef.current.ungroupLabel, () => {
        useStore.getState().ungroupTab(sourceTab.id);
      });
    }

    candidates.forEach((targetTab) => {
      const targetTitle = currentParameters.containerApi.getPanel(targetTab.id)?.title ?? targetTab.type;
      addMenuItem(`${labelsRef.current.groupWithLabel} ${targetTitle}`, () => {
        useStore.getState().groupTabs(
          [sourceTab.id, targetTab.id],
          sourceTab.visualGroupId ?? targetTab.visualGroupId,
        );
      });
    });

    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menuRect.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menuRect.height - 8)}px`;
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
  }

  return {
    element,
    init: (initialParameters) => {
      parameters = initialParameters;
      render();
      titleDisposable = initialParameters.api.onDidTitleChange(() => render());
      element.addEventListener("contextmenu", handleContextMenu);
    },
    dispose: () => {
      closeMenu();
      element.removeEventListener("contextmenu", handleContextMenu);
      titleDisposable?.dispose();
      titleDisposable = null;
      parameters = null;
    },
  };
}

function createNativeTabGroupChipRenderer({
  useStore,
  labelsRef,
}: {
  useStore: UseLayoutStore;
  labelsRef: RefObject<TabGroupLabels>;
}): ITabGroupChipRenderer {
  const element = document.createElement("div");
  element.className = "dv-tab-group-chip";
  element.tabIndex = 0;
  const label = document.createElement("span");
  label.className = "dv-tab-group-chip-label";
  element.appendChild(label);

  let tabGroup: ITabGroup | null = null;
  let menu: HTMLDivElement | null = null;
  const handleClick = () => tabGroup?.toggle();

  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  }

  function handleOutsidePointerDown(event: PointerEvent) {
    if (!menu || event.target instanceof Node && element.contains(event.target)) return;
    closeMenu();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") closeMenu();
  }

  function addMenuItem(labelText: string, onClick: () => void) {
    if (!menu) return;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dockview-header-action-menu-item";
    item.textContent = labelText;
    item.addEventListener("click", () => {
      onClick();
      closeMenu();
    });
    menu.appendChild(item);
  }

  function addRenameItem() {
    if (!menu || !tabGroup) return;
    const container = document.createElement("div");
    container.className = "dv-context-menu-rename";
    const input = document.createElement("input");
    input.className = "dv-context-menu-rename-input";
    input.value = tabGroup.label;
    input.placeholder = labelsRef.current.tabGroupLabel;
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      tabGroup?.setLabel(input.value.trim() || labelsRef.current.tabGroupLabel);
      closeMenu();
    });
    container.appendChild(input);
    menu.appendChild(container);
    window.setTimeout(() => input.focus(), 0);
  }

  function openMenu(event: MouseEvent) {
    const currentTabGroup = tabGroup;
    if (!currentTabGroup) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();

    menu = document.createElement("div");
    menu.className = "dockview-tab-menu";
    addRenameItem();

    const colorRow = document.createElement("div");
    colorRow.className = "dv-context-menu-color-picker";
    const colorTitle = document.createElement("span");
    colorTitle.textContent = labelsRef.current.groupColorLabel;
    colorRow.appendChild(colorTitle);
    const menuRef = menu;
    ["blue", "purple"].forEach((color) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "dv-context-menu-color-swatch";
      swatch.style.setProperty("--dv-tab-group-color", `var(--dv-tab-group-color-${color})`);
      swatch.addEventListener("click", () => {
        currentTabGroup.setColor(color);
        closeMenu();
      });
      menuRef.appendChild(swatch);
    });
    menu.appendChild(colorRow);

    addMenuItem(
      currentTabGroup.collapsed
        ? labelsRef.current.expandGroupLabel
        : labelsRef.current.collapseGroupLabel,
      () => currentTabGroup.toggle(),
    );
    addMenuItem(labelsRef.current.closeGroupLabel, () => {
      [...currentTabGroup.panelIds].forEach((panelId) => {
        useStore.getState().close(panelId);
      });
    });

    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menuRect.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menuRect.height - 8)}px`;
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
  }

  function render(current: ITabGroup) {
    label.textContent = current.label;
    label.classList.toggle("dv-tab-group-chip-label--empty", !current.label);
    element.classList.toggle("dv-tab-group-chip--collapsed", current.collapsed);
    const color = current.color === "blue" || current.color === "purple"
      ? current.color
      : "blue";
    element.style.setProperty("--dv-tab-group-color", `var(--dv-tab-group-color-${color})`);
  }

  return {
    element,
    init: (params) => {
      tabGroup = params.tabGroup;
      render(params.tabGroup);
      element.addEventListener("click", handleClick);
      element.addEventListener("contextmenu", openMenu);
    },
    update: (params) => {
      tabGroup = params.tabGroup;
      render(params.tabGroup);
    },
    dispose: () => {
      closeMenu();
      element.removeEventListener("click", handleClick);
      element.removeEventListener("contextmenu", openMenu);
      tabGroup = null;
    },
  };
}

function useThemeMode() {
  const [mode, setMode] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "dark";
    if (document.documentElement.classList.contains("light")) return "light";
    if (document.documentElement.classList.contains("dark")) return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    function update() {
      if (document.documentElement.classList.contains("light")) {
        setMode("light");
        return;
      }
      if (document.documentElement.classList.contains("dark")) {
        setMode("dark");
        return;
      }
      setMode(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    }

    update();
    const media = window.matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);

  return mode;
}

export function DockviewTabs({
  useStore,
  ariaLabel,
  titleForTab,
  emptyLabel,
  emptyState,
  newTabLabel,
  newTabs,
  openNewTab,
  domain,
  groupWithLabel,
  ungroupLabel,
  tabGroupLabel,
  closeTabLabel,
  renameGroupLabel,
  groupColorLabel,
  collapseGroupLabel,
  expandGroupLabel,
  closeGroupLabel,
  leadingAction,
  toolbarAction,
  trailingAction,
}: DockviewTabsProps) {
  const tabs = useStore((state) => state.tabs ?? []);
  const activeId = useStore((state) => state.activeTabId);
  const availableNewTabs = useMemo(() => newTabs.filter((option) => (
    isTabAllowedInDomain(domain, option.type)
    && (!option.singleInstance || !tabs.some((tab) => tab.type === option.type))
  )), [domain, newTabs, tabs]);
  const apiRef = useRef<DockviewApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<number | null>(null);
  const suppressCloseRef = useRef(false);
  const themeMode = useThemeMode();
  const propsRef = useRef({ titleForTab });
  const ariaLabelRef = useRef(ariaLabel);
  const emptyLabelRef = useRef(emptyLabel);
  const tabGroupLabelsRef = useRef<TabGroupLabels>({
    groupWithLabel,
    ungroupLabel,
    tabGroupLabel,
    closeTabLabel,
    renameGroupLabel,
    groupColorLabel,
    collapseGroupLabel,
    expandGroupLabel,
    closeGroupLabel,
  });
  const actionPropsRef = useRef({
    availableNewTabs,
    newTabLabel,
    openNewTab,
    leadingAction,
    toolbarAction,
    trailingAction,
  });
  const themeModeRef = useRef(themeMode);
  const suppressNativeGroupSyncRef = useRef(false);

  useEffect(() => {
    propsRef.current.titleForTab = titleForTab;
    ariaLabelRef.current = ariaLabel;
    emptyLabelRef.current = emptyLabel;
    tabGroupLabelsRef.current = { groupWithLabel, ungroupLabel, tabGroupLabel, closeTabLabel };
    themeModeRef.current = themeMode;
    actionPropsRef.current = {
      availableNewTabs,
      newTabLabel,
      openNewTab,
      leadingAction,
      toolbarAction,
      trailingAction,
    };
  }, [
    availableNewTabs,
    ariaLabel,
    emptyLabel,
    leadingAction,
    newTabLabel,
    openNewTab,
    groupWithLabel,
    ungroupLabel,
    tabGroupLabel,
    closeTabLabel,
    renameGroupLabel,
    groupColorLabel,
    collapseGroupLabel,
    expandGroupLabel,
    closeGroupLabel,
    themeMode,
    titleForTab,
    toolbarAction,
    trailingAction,
  ]);

  const addTab = useCallback((api: DockviewApi, tab: Tab) => {
    const referencePanelId = api.activePanel?.id ?? api.panels.at(-1)?.id;
    api.addPanel({
      id: tab.id,
      component: tab.type,
      tabComponent: "ergatai-tab",
      title: propsRef.current.titleForTab(tab.type),
      params: {
        conversationId: tab.agentId ?? tab.id,
        tabType: tab.type,
      },
      renderer: "always",
      ...(referencePanelId
        ? { position: { referencePanel: referencePanelId, direction: "within" as const } }
        : {}),
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", ariaLabelRef.current);

    const dock = new DockviewComponent(container, {
      className: "ergatai-dockview",
      theme: dockviewThemes[themeModeRef.current],
      createComponent: createPanelContentRenderer,
      defaultTabComponent: "ergatai-tab",
      createTabComponent: ({ name }) => (name === "ergatai-tab"
        ? createNativeTabRenderer({ useStore, labelsRef: tabGroupLabelsRef })
        : undefined),
      tabGroupColors: [
        { id: "blue", value: "var(--tab-group-blue-solid)" },
        { id: "purple", value: "var(--tab-group-purple-solid)" },
      ],
      createTabGroupChipComponent: () => createNativeTabGroupChipRenderer({
        useStore,
        labelsRef: tabGroupLabelsRef,
      }),
      createPrefixHeaderActionComponent: () => createHeaderActionRenderer(
        actionPropsRef.current.leadingAction,
      ),
      createLeftHeaderActionComponent: () => createNewTabAction(actionPropsRef),
      createRightHeaderActionComponent: () => createHeaderActionRenderer(
        <>
          {actionPropsRef.current.toolbarAction}
          {actionPropsRef.current.trailingAction}
        </>,
      ),
      createWatermarkComponent: () => ({
        element: (() => {
          const element = document.createElement("div");
          element.className = "dockview-watermark";
          element.textContent = emptyLabelRef.current;
          return element;
        })(),
        init: () => {},
      }),
      defaultRenderer: "always",
      noPanelsOverlay: "watermark",
    });
    const api = new DockviewApi(dock);
    apiRef.current = api;

    const disposables = [
      api.onDidActivePanelChange((event) => {
        const nextActiveId = event.panel?.id;
        if (nextActiveId && nextActiveId !== useStore.getState().activeTabId) {
          useStore.getState().activate(nextActiveId);
        }
      }),
      api.onDidRemovePanel((event) => {
        if (suppressCloseRef.current) return;
        useStore.getState().close(event.id);
      }),
      api.onDidAddPanelToTabGroup((event) => {
        if (suppressNativeGroupSyncRef.current) return;
        const storeGroupId = getStoreGroupId(event.tabGroup.componentParams);
        if (!storeGroupId) return;
        useStore.getState().groupTabs([...event.tabGroup.panelIds], storeGroupId);
      }),
      api.onDidRemovePanelFromTabGroup((event) => {
        if (suppressNativeGroupSyncRef.current) return;
        const storeGroupId = getStoreGroupId(event.tabGroup.componentParams);
        const tab = useStore.getState().tabs.find((item) => item.id === event.panelId);
        if (storeGroupId && tab?.visualGroupId === storeGroupId) {
          useStore.getState().ungroupTab(event.panelId);
        }
      }),
      api.onDidTabGroupChange((event) => {
        const storeGroupId = getStoreGroupId(event.tabGroup.componentParams);
        if (storeGroupId && isStoreGroupColor(event.tabGroup.color)) {
          useStore.getState().setTabGroupColor(storeGroupId, event.tabGroup.color);
        }
      }),
      api.onDidLayoutChange(() => {
        useStore.getState().syncPanes(
          api.groups.map((group) => ({
            id: group.id,
            tabOrder: group.panels.map((panel) => panel.id),
            activeTabId: group.activePanel?.id ?? null,
          })),
          api.activePanel?.group.id ?? null,
        );
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          useStore.getState().setDockviewLayout(api.toJSON());
        }, 180);
      }),
    ];

    const currentTabs = useStore.getState().tabs;
    currentTabs.forEach((tab) => addTab(api, tab));

    return () => {
      disposables.forEach((disposable) => disposable.dispose());
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      dock.dispose();
      apiRef.current = null;
    };
  }, [addTab, useStore]);

  useEffect(() => {
    containerRef.current?.setAttribute("aria-label", ariaLabel);
  }, [ariaLabel]);

  useEffect(() => {
    if (!activeId) return;
    const api = apiRef.current;
    const panel = api?.getPanel(activeId);
    if (api && panel && api.activePanel?.id !== activeId) {
      panel.api.setActive();
    }
  }, [activeId]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const storeIds = new Set(tabs.map((tab) => tab.id));
    const dockPanelIds = new Set(api.panels.map((panel) => panel.id));
    suppressCloseRef.current = true;
    api.panels.filter((panel) => !storeIds.has(panel.id)).forEach((panel) => api.removePanel(panel));
    suppressCloseRef.current = false;

    tabs.filter((tab) => !dockPanelIds.has(tab.id)).forEach((tab) => addTab(api, tab));
  }, [addTab, tabs]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const groupedTabsByStoreGroup = new Map<string, Tab[]>();
    tabs.forEach((tab) => {
      if (!tab.visualGroupId) return;
      const members = groupedTabsByStoreGroup.get(tab.visualGroupId) ?? [];
      members.push(tab);
      groupedTabsByStoreGroup.set(tab.visualGroupId, members);
    });

    suppressNativeGroupSyncRef.current = true;

    groupedTabsByStoreGroup.forEach((members, storeGroupId) => {
      const dockPanels = members
        .map((tab) => api.getPanel(tab.id))
        .filter((panel): panel is NonNullable<typeof panel> => Boolean(panel));
      if (dockPanels.length < 2) return;

      const dockGroupId = dockPanels[0].group.id;
      const sameDockGroupMembers = members.filter((tab) => (
        api.getPanel(tab.id)?.group.id === dockGroupId
      ));
      if (sameDockGroupMembers.length < 2) return;

      let nativeTabGroup = getNativeTabGroup(api, dockGroupId, storeGroupId);
      if (!nativeTabGroup) {
        nativeTabGroup = api.createTabGroup({
          groupId: dockGroupId,
          label: tabGroupLabelsRef.current.tabGroupLabel,
          color: sameDockGroupMembers[0].groupColor,
          componentParams: { storeGroupId },
        });
      }

      sameDockGroupMembers.forEach((tab) => {
        if (!nativeTabGroup?.containsPanel(tab.id)) {
          api.addPanelToTabGroup({
            groupId: dockGroupId,
            tabGroupId: nativeTabGroup.id,
            panelId: tab.id,
          });
        }
      });

      const expectedPanelIds = new Set(sameDockGroupMembers.map((tab) => tab.id));
      nativeTabGroup.panelIds.filter((panelId) => !expectedPanelIds.has(panelId)).forEach((panelId) => {
        api.removePanelFromTabGroup({ groupId: dockGroupId, panelId });
      });
    });

    suppressNativeGroupSyncRef.current = false;
  }, [tabs, tabGroupLabel]);

  useEffect(() => {
    const api = apiRef.current;
    if (api) {
      api.updateOptions({
        theme: dockviewThemes[themeMode],
      });
    }
  }, [themeMode]);

  function createTab(type: TabType) {
    openNewTab(type);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg" aria-label={ariaLabel}>
      <div ref={containerRef} className="dockview-workspace min-h-0 flex-1" />
      {tabs.length === 0 && (
        <div className="absolute inset-0 z-10 flex flex-col bg-bg">
          <div className="flex h-10 shrink-0 items-center border-b border-border-subtle bg-surface px-2">
            {leadingAction && <div className="flex items-center">{leadingAction}</div>}
            <div className="ml-auto flex items-center gap-1">
              {toolbarAction}
              {trailingAction}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-[12px] text-faint">
            {emptyState?.(createTab) ?? emptyLabel}
          </div>
        </div>
      )}
    </div>
  );
}

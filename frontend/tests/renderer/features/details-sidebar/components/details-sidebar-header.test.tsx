/**
 * Component tests for DetailsSidebarHeader
 *
 * Tests cover:
 * - Basic rendering with different tabs
 * - Button click handlers
 * - Conditional rendering based on activeTab
 * - Accessibility (aria-labels)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

// Use vi.hoisted to ensure mocks are defined before any imports
const {
  mockUseResolvedHotkeyDisplay,
  MockButton,
  MockTooltip,
  MockTooltipTrigger,
  MockTooltipContent,
  MockIconDoubleChevronRight,
  MockSearchIcon,
  MockExpandIcon,
  MockCollapseIcon,
  MockKbd,
  MockWidgetSettingsPopup,
} = vi.hoisted(() => {
  const mockUseResolvedHotkeyDisplay = vi.fn(() => "Ctrl+D")

  const MockButton = vi.fn(
    ({ children, onClick, className, "aria-label": ariaLabel, ...props }) => (
      <button
        onClick={onClick}
        className={className}
        aria-label={ariaLabel}
        {...props}
      >
        {children}
      </button>
    ),
  )

  const MockTooltip = vi.fn(({ children }) => <div>{children}</div>)
  const MockTooltipTrigger = vi.fn(({ children, asChild }) =>
    asChild ? children : <div>{children}</div>,
  )
  const MockTooltipContent = vi.fn(({ children }) => (
    <div data-testid="tooltip-content">{children}</div>
  ))

  const MockIconDoubleChevronRight = vi.fn(() => <span>→</span>)
  const MockSearchIcon = vi.fn(() => <span data-testid="search-icon">🔍</span>)
  const MockExpandIcon = vi.fn(() => (
    <span data-testid="expand-icon">⊕</span>
  ))
  const MockCollapseIcon = vi.fn(() => (
    <span data-testid="collapse-icon">⊖</span>
  ))

  const MockKbd = vi.fn(({ children }) => <kbd>{children}</kbd>)

  const MockWidgetSettingsPopup = vi.fn(() => (
    <div data-testid="widget-settings-popup">Settings</div>
  ))

  return {
    mockUseResolvedHotkeyDisplay,
    MockButton,
    MockTooltip,
    MockTooltipTrigger,
    MockTooltipContent,
    MockIconDoubleChevronRight,
    MockSearchIcon,
    MockExpandIcon,
    MockCollapseIcon,
    MockKbd,
    MockWidgetSettingsPopup,
  }
})

// Mock modules
vi.mock("@/lib/hotkeys", () => ({
  useResolvedHotkeyDisplay: mockUseResolvedHotkeyDisplay,
}))

vi.mock("@/components/ui/button", () => ({
  Button: MockButton,
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: MockTooltip,
  TooltipTrigger: MockTooltipTrigger,
  TooltipContent: MockTooltipContent,
}))

vi.mock("@/components/ui/icons", () => ({
  IconDoubleChevronRight: MockIconDoubleChevronRight,
  SearchIcon: MockSearchIcon,
  ExpandIcon: MockExpandIcon,
  CollapseIcon: MockCollapseIcon,
}))

vi.mock("@/components/ui/kbd", () => ({
  Kbd: MockKbd,
}))

vi.mock("@/features/details-sidebar/widget-settings-popup", () => ({
  WidgetSettingsPopup: MockWidgetSettingsPopup,
}))

import { DetailsSidebarHeader } from "@/features/details-sidebar/components/details-sidebar-header"

describe("DetailsSidebarHeader", () => {
  const defaultProps = {
    chatId: "test-chat-123",
    activeTab: "details" as const,
    onClose: vi.fn(),
    filesAllExpanded: true,
    onOpenFileSearch: vi.fn(),
    onToggleFilesExpandCollapse: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("Rendering", () => {
    it("should render with details tab", () => {
      render(<DetailsSidebarHeader {...defaultProps} />)

      expect(screen.getByText("Details")).toBeInTheDocument()
      expect(screen.getByLabelText("Close details")).toBeInTheDocument()
    })

    it("should render with files tab", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="files" />)

      expect(screen.getByText("Files")).toBeInTheDocument()
    })

    it("should render with git tab", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="git" />)

      expect(screen.getByText("Git")).toBeInTheDocument()
    })

    it("should render close button with correct aria-label", () => {
      render(<DetailsSidebarHeader {...defaultProps} />)

      const closeButton = screen.getByLabelText("Close details")
      expect(closeButton).toBeInTheDocument()
      expect(closeButton.tagName.toLowerCase()).toBe("button")
    })
  })

  describe("Interactions", () => {
    it("should call onClose when close button is clicked", () => {
      const onClose = vi.fn()
      render(<DetailsSidebarHeader {...defaultProps} onClose={onClose} />)

      const closeButton = screen.getByLabelText("Close details")
      fireEvent.click(closeButton)

      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it("should render WidgetSettingsPopup when activeTab is details", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="details" />)

      expect(screen.getByTestId("widget-settings-popup")).toBeInTheDocument()
    })

    it("should not render WidgetSettingsPopup when activeTab is files", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="files" />)

      expect(
        screen.queryByTestId("widget-settings-popup"),
      ).not.toBeInTheDocument()
    })

    it("should render search icon button when activeTab is files", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="files" />)

      expect(screen.getByTestId("search-icon")).toBeInTheDocument()
    })

    it("should call onOpenFileSearch when search button is clicked", () => {
      const onOpenFileSearch = vi.fn()
      render(
        <DetailsSidebarHeader
          {...defaultProps}
          activeTab="files"
          onOpenFileSearch={onOpenFileSearch}
        />,
      )

      // Find the button that contains the search icon
      const searchButton = screen.getByTestId("search-icon").closest("button")
      expect(searchButton).toBeInTheDocument()
      fireEvent.click(searchButton!)

      expect(onOpenFileSearch).toHaveBeenCalledTimes(1)
    })

    it("should render collapse icon when filesAllExpanded is true", () => {
      render(
        <DetailsSidebarHeader {...defaultProps} activeTab="files" filesAllExpanded={true} />,
      )

      expect(screen.getByTestId("collapse-icon")).toBeInTheDocument()
    })

    it("should render expand icon when filesAllExpanded is false", () => {
      render(
        <DetailsSidebarHeader {...defaultProps} activeTab="files" filesAllExpanded={false} />,
      )

      expect(screen.getByTestId("expand-icon")).toBeInTheDocument()
    })

    it("should call onToggleFilesExpandCollapse when expand/collapse button is clicked", () => {
      const onToggleFilesExpandCollapse = vi.fn()
      render(
        <DetailsSidebarHeader
          {...defaultProps}
          activeTab="files"
          onToggleFilesExpandCollapse={onToggleFilesExpandCollapse}
        />,
      )

      // Find the button that contains the collapse icon
      const collapseButton = screen
        .getByTestId("collapse-icon")
        .closest("button")
      expect(collapseButton).toBeInTheDocument()
      fireEvent.click(collapseButton!)

      expect(onToggleFilesExpandCollapse).toHaveBeenCalledTimes(1)
    })
  })

  describe("Conditional rendering", () => {
    it("should show WidgetSettingsPopup for details tab", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="details" />)

      expect(screen.getByTestId("widget-settings-popup")).toBeInTheDocument()
    })

    it("should show file controls for files tab", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="files" />)

      expect(screen.getByTestId("search-icon")).toBeInTheDocument()
      expect(screen.getByTestId("collapse-icon")).toBeInTheDocument()
    })

    it("should show minimal controls for git tab", () => {
      render(<DetailsSidebarHeader {...defaultProps} activeTab="git" />)

      expect(screen.getByText("Git")).toBeInTheDocument()
      expect(screen.getByLabelText("Close details")).toBeInTheDocument()
      expect(
        screen.queryByTestId("widget-settings-popup"),
      ).not.toBeInTheDocument()
      expect(screen.queryByTestId("search-icon")).not.toBeInTheDocument()
    })
  })

  describe("Remote chat", () => {
    it("should pass isRemoteChat to WidgetSettingsPopup", () => {
      render(
        <DetailsSidebarHeader
          {...defaultProps}
          activeTab="details"
          isRemoteChat={true}
        />,
      )

      expect(screen.getByTestId("widget-settings-popup")).toBeInTheDocument()
    })
  })
})

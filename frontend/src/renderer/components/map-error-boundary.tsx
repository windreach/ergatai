import React from "react"

type ErrorBoundaryState = {
  hasError: boolean
  error: Error | null
}

export class MapErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("🔴 MapErrorBoundary caught an error:", error)
    console.error("Error info:", errorInfo)
    console.error("Component stack:", errorInfo.componentStack)

    // Show detailed error message
    if (error.message.includes("Cannot read properties of undefined")) {
      console.error("\n=== MAP ERROR DETAILS ===")
      console.error("This is likely a .map() call on undefined data")
      console.error("Common causes:")
      console.error("1. React Query data not yet loaded (use ?? [])")
      console.error("2. Optional prop not provided (use default value)")
      console.error("3. API response missing field (add null check)")
      console.error("========================\n")
    }
  }

  render() {
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return (
        <div className="p-4 text-sm text-destructive">
          <h3 className="font-semibold">Something went wrong</h3>
          <p className="mt-2 text-muted-foreground">{this.state.error?.message}</p>
          <button
            className="mt-2 text-xs underline"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

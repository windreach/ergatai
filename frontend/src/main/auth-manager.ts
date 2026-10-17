import { app } from "electron"

export interface DesktopUser {
  id: string
  email: string
  name?: string | null
  imageUrl?: string | null
  username?: string | null
}

class LocalAuthManager {
  private user: DesktopUser

  constructor() {
    this.user = {
      id: "local-user",
      email: "local@ergatai.desktop",
      name: app.getName(),
    }
  }

  getUser(): DesktopUser {
    return this.user
  }

  isAuthenticated(): boolean {
    return true
  }

  async getValidToken(): Promise<null> {
    return null
  }

  async updateUser(updates: { name?: string }): Promise<DesktopUser> {
    if (updates.name) this.user.name = updates.name
    return this.user
  }

  async fetchUserPlan(): Promise<null> {
    return null
  }

  setOnTokenRefresh(_callback: (authData: unknown) => void): void {}

  logout(): void {}

  startAuthFlow(): void {}
}

let authManager: LocalAuthManager | null = null

export function initAuthManager(): LocalAuthManager {
  authManager ??= new LocalAuthManager()
  return authManager
}

export function getAuthManager(): LocalAuthManager | null {
  return authManager
}

export { LocalAuthManager as AuthManager }

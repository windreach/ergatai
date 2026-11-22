// Patches the Electron dev runtime so the desktop shell shows "Ergatai" and
// the product icon instead of the generic Electron/gear icon.
//
// macOS: rewrites Electron.app's Info.plist and electron.icns.
// Linux: installs a NoDisplay .desktop entry whose StartupWMClass matches the
//        dev window's app_id (ergatai-dev), so the dock resolves the icon
//        without shadowing an installed release entry.
import { execFileSync } from "child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const frontendRoot = join(root, "frontend")

const electronApp = join(frontendRoot, "node_modules/electron/dist/Electron.app")
const plistPath = join(electronApp, "Contents/Info.plist")
const icnsSource = join(frontendRoot, "build/icon.icns")
const icnsDest = join(electronApp, "Contents/Resources/electron.icns")

function quoteExecArg(value) {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`
}

function installLinuxDevDesktopEntry() {
  if (process.env.CI) return

  const electronBinary = join(frontendRoot, "node_modules/electron/dist/electron")
  const iconPath = join(frontendRoot, "build/icon.png")
  const applicationsDir = join(homedir(), ".local/share/applications")
  const desktopFile = join(applicationsDir, "ergatai-dev.desktop")
  const legacyDesktopFile = join(applicationsDir, "ergatai-ui.desktop")

  if (!existsSync(electronBinary) || !existsSync(iconPath)) {
    console.warn("[patch-electron-dev] Electron binary or icon missing; skipping desktop entry")
    return
  }

  const contents = `[Desktop Entry]
Type=Application
Name=Ergatai
Comment=Ergatai (development)
Exec=${quoteExecArg(electronBinary)} ${quoteExecArg(frontendRoot)}
Icon=${iconPath}
Terminal=false
NoDisplay=true
StartupNotify=true
StartupWMClass=ergatai-dev
`

  try {
    mkdirSync(applicationsDir, { recursive: true })
    if (existsSync(legacyDesktopFile)) {
      try {
        unlinkSync(legacyDesktopFile)
      } catch {
        // Old entry may be owned by another process.
      }
    }
    let previous = null
    try {
      previous = readFileSync(desktopFile, "utf-8")
    } catch {
      // First run.
    }
    if (previous !== contents) {
      writeFileSync(desktopFile, contents, "utf-8")
      console.log("[patch-electron-dev] Installed Linux dev desktop entry:", desktopFile)
    }
    try {
      execFileSync("update-desktop-database", [applicationsDir], { stdio: "ignore" })
    } catch {
      // update-desktop-database is optional.
    }
  } catch (e) {
    console.warn("[patch-electron-dev] Failed to install Linux desktop entry:", e.message)
  }
}

if (process.platform === "linux") {
  installLinuxDevDesktopEntry()
  process.exit(0)
}

if (process.platform !== "darwin") {
  process.exit(0)
}

if (existsSync(plistPath)) {
  try {
    // Use execFileSync to avoid command injection via plistPath
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleName Ergatai", plistPath])
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleDisplayName Ergatai", plistPath])
    console.log("[patch-electron-dev] Updated Info.plist: name -> Ergatai")
  } catch (e) {
    console.warn("[patch-electron-dev] Failed to update Info.plist:", e.message)
  }
}

if (existsSync(icnsSource) && existsSync(icnsDest)) {
  copyFileSync(icnsSource, icnsDest)
  console.log("[patch-electron-dev] Replaced electron.icns with custom icon")
}

// Touch the .app bundle so macOS re-reads it
if (existsSync(electronApp)) {
  // Use execFileSync to avoid command injection via electronApp
  execFileSync("touch", [electronApp])
}

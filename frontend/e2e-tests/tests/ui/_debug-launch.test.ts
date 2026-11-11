import { test } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"

test("debug launch", async () => {
  const electron = await launchElectron({ extraEnv: { NODE_ENV: "test", ELECTRON_TEST_MODE: "true", ERGATAI_API_URL: "http://127.0.0.1:3000" } })
  const page = electron.page
  page.on("console", (m) => console.log("CONSOLE", m.type(), m.text()))
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message))
  await page.waitForTimeout(8000)
  const html = await page.content()
  console.log("HTML", html.slice(0, 2000))
  await electron.close()
})
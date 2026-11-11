import { test } from "@playwright/test"
import { launchElectron } from "../../fixtures/electron-launcher"
test("dump", async () => {
  const e = await launchElectron({ extraEnv: { NODE_ENV: "test", ELECTRON_TEST_MODE: "true" } })
  const page = e.page
  await page.waitForTimeout(8000)
  console.log("BODY_LEN::" + await page.evaluate(() => document.body.innerText.length))
  await e.close()
})

from playwright.sync_api import sync_playwright


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 900, "height": 820})
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:1420/fast-ship-harness.html")
        page.wait_for_load_state("networkidle")
        page.wait_for_function("() => Boolean(window.__fastShipHarness)")

        initial = page.evaluate("() => window.__fastShipHarness.initial()")
        assert initial["profile"] == "auto"
        assert initial["activeLabel"] == "Auto"
        assert "3 protected actions" in initial["checkpointText"]
        assert "WORKSPACE TIME MACHINE" in page.locator("#changes-panel").inner_text().upper()
        assert "Edit file" in initial["checkpointText"]
        assert "src/main.ts" in initial["checkpointText"]
        assert "Whole project snapshot" in initial["checkpointText"]
        assert "Shell-command side effects" in initial["checkpointText"]
        assert initial["rollbackDisabled"] is False
        assert initial["foreground"] != initial["background"], "light-mode checkpoint text is invisible"

        fast = page.evaluate("() => window.__fastShipHarness.select('fast')")
        assert fast["profile"] == "fast"
        assert fast["activeLabel"] == "Fast"
        assert fast["storedProfile"] == "fast"

        rolled_back = page.evaluate("() => window.__fastShipHarness.rollbackRun()")
        call = rolled_back["rollbackCalls"][-1]
        assert call["args"]["checkpointId"] == "checkpoint-1"
        assert call["args"]["scope"] == "run"
        assert "Rolled back 3 agent actions" in rolled_back["notice"]
        assert "error" not in rolled_back["noticeClass"]

        conflict = page.evaluate("() => window.__fastShipHarness.rollbackConflict()")
        assert "preserved for safety" in conflict["notice"]
        assert "src/main.ts changed after" in conflict["notice"]
        assert "error" in conflict["noticeClass"]
        assert not page_errors, f"browser errors: {page_errors}"
        browser.close()

    print("Fast Ship checks passed: profile routing UI, persistence, rollback, conflicts, light theme")


if __name__ == "__main__":
    main()

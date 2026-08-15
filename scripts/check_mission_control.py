from playwright.sync_api import sync_playwright


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1180, "height": 900})
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:1420/client-success-harness.html")
        page.wait_for_load_state("networkidle")
        page.wait_for_function("() => Boolean(window.__clientSuccessHarness)")
        page.click("#open-client-success")

        snapshot = page.evaluate("() => window.__clientSuccessHarness.snapshot()")
        assert snapshot["title"] == "Mission Control"
        assert "Start Mission" in snapshot["start"]
        assert "Test & Fix Everything" in snapshot["testFix"]
        assert snapshot["permissions"] == 3
        assert snapshot["policy"] == "risk_gates"

        modal_box = page.locator("[data-mission-control]").bounding_box()
        assert modal_box is not None
        assert modal_box["x"] >= 0 and modal_box["x"] + modal_box["width"] <= 1180
        assert modal_box["y"] >= 0 and modal_box["y"] + modal_box["height"] <= 900

        contract = page.evaluate("() => window.__clientSuccessHarness.save()")
        assert "Persistent Mission Control Contract" in contract
        assert "Ship a mobile-first ordering flow" in contract
        assert "Execution depth: Maximum" in contract
        assert "Preview Computer Use" in contract

        mission = page.evaluate("() => window.__clientSuccessHarness.startMission()")
        request = mission["request"]
        assert request["id"] == "mission"
        assert request["requestedMode"] == "adaptive"
        assert request["executionProfile"] == "safe"
        assert request["visibleText"].startswith("Start Mission:")
        assert "visible plan" in request["prompt"]

        page.wait_for_timeout(550)
        page.click("#open-client-success")
        quality = page.evaluate("() => window.__clientSuccessHarness.startTestFix()")
        quality_request = quality["request"]
        assert quality_request["id"] == "qa"
        assert quality_request["requestedMode"] == "build"
        assert quality_request["executionProfile"] == "safe"
        assert quality_request["enableComputerUse"] is True
        assert "inspect → test → fix → retest" in quality_request["prompt"]
        assert "Never fabricate" in quality_request["prompt"]

        page.wait_for_timeout(550)
        page.set_viewport_size({"width": 430, "height": 820})
        page.click("#open-client-success")
        mobile_box = page.locator("[data-mission-control]").bounding_box()
        assert mobile_box is not None
        assert mobile_box["x"] >= 0 and mobile_box["x"] + mobile_box["width"] <= 430
        assert page.locator("[data-start-mission]").is_visible()
        assert page.locator("[data-start-test-fix]").is_visible()
        assert not page_errors, f"browser errors: {page_errors}"
        browser.close()

    print("Mission Control checks passed: contract, guardrails, launch routing, Test & Fix, responsive layout")


if __name__ == "__main__":
    main()

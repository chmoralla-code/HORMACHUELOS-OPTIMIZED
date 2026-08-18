import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = "http://127.0.0.1:1420/update-harness.html"
SCREENSHOT = Path(__file__).resolve().parents[1] / "test-results" / "update-button-available.png"
DIALOG_SCREENSHOT = Path(__file__).resolve().parents[1] / "test-results" / "update-dialog-available.png"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1000, "height": 760})
        page.goto(BASE_URL, wait_until="networkidle")

        # Secondary project controls are collapsed so the project, session,
        # and account panels have permanent room in the sidebar. The update
        # action must remain directly visible.
        workspace_actions = page.locator("summary.sb-actions-toggle")
        expect(workspace_actions).to_be_visible()
        assert workspace_actions.inner_text() == "Workspace actions"
        assert not page.get_by_role("button", name="New Build", exact=True).is_visible()
        for selector in [
            ".sb-projects-section .sb-section-label",
            ".sb-sessions-section .sb-section-label",
            ".sb-account-usage > summary",
        ]:
            expect(page.locator(selector)).to_be_visible()

        update_button = page.get_by_role(
            "button", name="Update available: v0.1.5. Install and restart", exact=True
        )
        update_button.wait_for(state="visible")
        workspace_actions.click()
        for name in ["New Build", "Open Project", "Client Pack"]:
            expect(page.get_by_role("button", name=name, exact=True)).to_be_visible()
        expect(update_button).to_be_visible()
        assert update_button.evaluate(
            "button => { const r = button.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 8, r.top + 8); return top === button || button.contains(top); }"
        )
        page.get_by_role("button", name="Client Pack", exact=True).click()
        assert not page.locator(".sb-action-menu").evaluate("menu => menu.open")
        assert update_button.get_attribute("data-update-available") == "true"
        assert update_button.locator(".sb-action-label").count() == 1
        assert update_button.locator(".sb-action-label").inner_text() == "Update"
        assert update_button.locator(".ico svg").count() == 1
        assert update_button.locator(".sb-update-badge").inner_text() == "NEW · v0.1.5"
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), full_page=True)
        update_button.click()

        dialog = page.get_by_role("dialog", name="Update available")
        dialog.wait_for(state="visible")
        dialog.screenshot(path=str(DIALOG_SCREENSHOT))
        app = page.locator("#app")
        close_button = dialog.get_by_role("button", name="Close update checker")
        not_now_button = dialog.get_by_role("button", name="Not now")
        assert app.evaluate("node => node.inert")
        assert close_button.evaluate("button => button === document.activeElement")

        page.keyboard.press("Shift+Tab")
        assert not_now_button.evaluate("button => button === document.activeElement")
        page.keyboard.press("Tab")
        assert close_button.evaluate("button => button === document.activeElement")

        page.locator("#background-action").evaluate("button => button.focus()")
        assert dialog.evaluate("node => node.contains(document.activeElement)")
        assert "Added the in-app Update button." in dialog.inner_text()
        assert dialog.locator(".update-version-summary").count() == 1
        assert dialog.locator(".update-version-label").all_text_contents() == [
            "Installed", "Ready to install"
        ]
        assert dialog.locator(".update-version-value").all_text_contents() == [
            "v0.1.4", "v0.1.5"
        ]
        notes_group = dialog.locator(".update-notes-group")
        assert notes_group.count() == 1
        assert "Added the in-app Update button." in notes_group.inner_text()
        assert "Local workspace protected" in dialog.inner_text()
        assert "SHA-256 verification" in dialog.inner_text()
        not_now_button.click()
        assert dialog.count() == 0
        assert not app.evaluate("node => node.inert")
        expect(update_button).to_be_focused()

        page.evaluate("window.__updateMode = 'current'")
        update_button.click()
        current_dialog = page.get_by_role("dialog", name="You're up to date")
        current_dialog.wait_for(state="visible")
        assert app.evaluate("node => node.inert")
        assert "v0.1.4 is the latest version" in current_dialog.inner_text()
        current_dialog.get_by_role("button", name="Done").click()
        assert not app.evaluate("node => node.inert")
        expect(update_button).to_be_focused()

        page.evaluate("window.__updateMode = 'error'")
        update_button.click()
        error_dialog = page.get_by_role("dialog", name="Couldn't check for updates")
        error_dialog.wait_for(state="visible")
        page.evaluate("window.__updateMode = 'current'")
        error_dialog.get_by_role("button", name="Try again").click()
        retried_dialog = page.get_by_role("dialog", name="You're up to date")
        retried_dialog.wait_for(state="visible")
        assert retried_dialog.evaluate("node => node.contains(document.activeElement)")
        retried_dialog.get_by_role("button", name="Done").click()
        assert not app.evaluate("node => node.inert")
        expect(update_button).to_be_focused()

        page.evaluate("""
          window.__updateMode = 'available';
          localStorage.setItem('ai-forge:test-update-state', 'preserved');
        """)
        update_button.click()
        install_dialog = page.get_by_role("dialog", name="Update available")
        install_dialog.wait_for(state="visible")
        install_overlay = page.locator(".update-dialog-overlay")
        install_dialog.get_by_role(
            "button", name="Install v0.1.5", exact=True
        ).click()
        page.wait_for_function("document.body.dataset.installedVersion === '0.1.5'")
        assert page.locator("body").get_attribute("data-installed-url") == (
            "https://hormachuelos.vercel.app/downloads/"
            "Hormachuelos_0.1.5_x64_en-US.msi"
        )
        assert page.locator("body").get_attribute("data-installed-sha256") == "b" * 64
        backup = json.loads(page.locator("body").get_attribute("data-update-backup"))
        assert backup["entries"]["ai-forge:test-update-state"] == "preserved"
        expect(install_overlay.locator(".update-install-status")).to_contain_text("Restarting")

        # A full WebView localStorage previously aborted before the updater
        # could download anything. The live in-memory transcript must now flow
        # into the native backup while installation continues normally.
        quota_page = browser.new_page(viewport={"width": 1000, "height": 760})
        quota_page.goto(BASE_URL, wait_until="networkidle")
        quota_page.evaluate("""
          () => {
            const originalSetItem = Storage.prototype.setItem;
            window.__restoreStorageSetItem = () => {
              Storage.prototype.setItem = originalSetItem;
            };
            Storage.prototype.setItem = function () {
              throw new DOMException('Storage quota reached', 'QuotaExceededError');
            };
          }
        """)
        quota_page.get_by_role(
            "button", name="Update available: v0.1.5. Install and restart", exact=True
        ).click()
        quota_dialog = quota_page.get_by_role("dialog", name="Update available")
        quota_dialog.wait_for(state="visible")
        quota_dialog.get_by_role("button", name="Install v0.1.5", exact=True).click()
        quota_page.wait_for_function("document.body.dataset.installedVersion === '0.1.5'")
        assert quota_page.get_by_role("heading", name="Update paused").count() == 0
        quota_backup = json.loads(quota_page.locator("body").get_attribute("data-update-backup"))
        backed_up_sessions = json.loads(quota_backup["entries"]["ai-forge:sessions"])
        memory_session = next(
            session for session in backed_up_sessions if session["id"] == "session-memory-only"
        )
        assert memory_session["messages"][0]["text"] == "Keep this unsaved transcript safe."
        expect(quota_page.locator(".update-install-status")).to_contain_text("Restarting")
        quota_page.close()

        # Relaunch recovery merges the fresher backup copy over an existing
        # session instead of skipping the whole sessions key.
        restore_page = browser.new_page(viewport={"width": 1000, "height": 760})
        restore_page.goto(BASE_URL, wait_until="networkidle")
        restore_page.evaluate("""
          () => {
            const stored = [{
              id: 'session-merge',
              title: 'Stored copy',
              projectId: 'C:\\Projects\\Atlas',
              messages: [{ type: 'assistant', text: 'older' }],
              createdAt: 1,
            }];
            const backedUp = [{
              id: 'session-merge',
              title: 'Fresh copy',
              projectId: 'C:\\Projects\\Atlas',
              messages: [{ type: 'assistant', text: 'newer' }],
              createdAt: 1,
            }, {
              id: 'session-native-only',
              title: 'Native-only copy',
              projectId: 'C:\\Projects\\Atlas',
              messages: [],
              createdAt: 2,
            }];
            localStorage.setItem('ai-forge:sessions', JSON.stringify(stored));
            window.__restoreUpdateBackup = JSON.stringify({
              format: 1,
              savedAt: new Date().toISOString(),
              entries: { 'ai-forge:sessions': JSON.stringify(backedUp) },
            });
          }
        """)
        assert restore_page.evaluate("window.__restoreUpdateState()") == 1
        restored_sessions = restore_page.evaluate(
            "JSON.parse(localStorage.getItem('ai-forge:sessions'))"
        )
        restored_by_id = {session["id"]: session for session in restored_sessions}
        assert restored_by_id["session-merge"]["messages"][0]["text"] == "newer"
        assert "session-native-only" in restored_by_id
        assert restore_page.locator("body").get_attribute("data-update-backup-cleared") == "true"

        # A failed restore never clears the host-owned backup; the next launch
        # can try again after storage becomes writable.
        retained = restore_page.evaluate("""
          async () => {
            delete document.body.dataset.updateBackupCleared;
            localStorage.removeItem('ai-forge:restore-write-required');
            window.__restoreUpdateBackup = JSON.stringify({
              format: 1,
              savedAt: new Date().toISOString(),
              entries: { 'ai-forge:restore-write-required': 'safe' },
            });
            const originalSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function () {
              throw new DOMException('Storage quota reached', 'QuotaExceededError');
            };
            try {
              await window.__restoreUpdateState();
              return { failed: false };
            } catch (error) {
              return {
                failed: true,
                message: String(error?.message || error),
                backupRetained: Boolean(window.__restoreUpdateBackup),
                cleared: Boolean(document.body.dataset.updateBackupCleared),
              };
            } finally {
              Storage.prototype.setItem = originalSetItem;
            }
          }
        """)
        assert retained["failed"]
        assert "backup is safe" in retained["message"]
        assert retained["backupRetained"]
        assert not retained["cleared"]
        restore_page.close()

        # The compact-height layout must retain one readable project and
        # session row as well as the usage tracker. This mirrors a client
        # resizing the desktop window without hiding core workspace state.
        compact_page = browser.new_page(viewport={"width": 1000, "height": 600})
        compact_page.goto(BASE_URL, wait_until="networkidle")
        for selector in [
            ".sb-projects-section",
            ".sb-sessions-section",
            ".sb-account-usage",
            ".sb-update-action",
        ]:
            expect(compact_page.locator(selector)).to_be_visible()
        assert compact_page.locator(".sb-recent").evaluate(
            "node => node.getBoundingClientRect().height >= 30"
        )
        assert compact_page.locator(".sb-projects-list").evaluate(
            "node => node.getBoundingClientRect().height >= 30"
        )
        compact_page.close()

        browser.close()

    print("Desktop Update button checks passed.")


if __name__ == "__main__":
    main()

from playwright.sync_api import sync_playwright


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:1420/session-lifecycle-harness.html")
        page.wait_for_function("() => Boolean(window.__sessionLifecycleHarness)")

        registry = page.evaluate("() => window.__sessionLifecycleHarness.reconcileRunIds()")
        assert registry["activeIds"] == [
            "native-active",
            "native-restored",
            "still-starting",
        ], registry
        assert registry["releasedIds"] == ["stale-finished"], registry

        completed = page.evaluate("() => window.__sessionLifecycleHarness.loadCompleted(60)")
        page.wait_for_timeout(900)
        completed = page.evaluate("() => window.__sessionLifecycleHarness.stats()")
        assert completed["busy"] == "false", completed
        assert completed["workingRows"] == 0, completed
        assert completed["runningBatches"] == 0, completed
        assert completed["workingLabels"] == 0, completed
        assert completed["shimmerLabels"] == 0, completed
        assert completed["perLetterNodes"] == 0, completed
        assert completed["stopVisible"] is False, completed
        assert set(completed["liveBadges"]) == {"DONE"}, completed
        assert completed["multiAgentBatches"] == 1, completed
        assert completed["multiAgentRows"] == 60, completed
        assert completed["historyVisibility"] == "auto", completed
        assert completed["runningAnimations"] == 0, completed

        # Sixty historical multi-agent batches should still sustain a normal
        # display cadence once their terminal state is restored.
        frame_sample = page.evaluate("() => window.__sessionLifecycleHarness.sampleFrames(90)")
        assert frame_sample["p95Ms"] < 40, frame_sample
        animation_model = page.evaluate(
            "() => window.__sessionLifecycleHarness.compareAnimationModels(40, 60)"
        )
        assert animation_model["legacyAnimations"] == 2400, animation_model
        assert animation_model["currentAnimations"] == 40, animation_model
        assert animation_model["animationReduction"] > 0.98, animation_model

        interrupted = page.evaluate("() => window.__sessionLifecycleHarness.loadInterrupted()")
        assert interrupted["busy"] == "false", interrupted
        assert interrupted["workingRows"] == 0, interrupted
        assert interrupted["workingLabels"] == 0, interrupted
        assert interrupted["liveBadges"] == ["STOPPED"], interrupted

        active = page.evaluate("() => window.__sessionLifecycleHarness.loadActive()")
        assert active["busy"] == "true", active
        assert active["workingRows"] == 1, active
        assert active["runningBatches"] == 1, active
        assert active["workingLabels"] == 1, active
        assert active["liveBadges"] == ["LIVE"], active
        assert active["shimmerLabels"] <= 2, active
        assert active["perLetterNodes"] == 0, active
        assert active["stopVisible"] is True, active

        reply = page.evaluate("() => window.__sessionLifecycleHarness.loadReplyLayout()")
        assert reply["assistantCount"] == 1, reply
        assert reply["emptyAssistantCount"] == 0, reply
        assert "Executive summary" in reply["assistantText"], reply
        assert "Let me inspect" not in reply["assistantText"], reply
        assert reply["structured"] is True, reply
        assert reply["fontSize"] >= 14.0, reply
        assert reply["lineHeight"] / reply["fontSize"] >= 1.65, reply
        assert 500 <= reply["bodyWidth"] <= 900, reply
        assert reply["headingTransform"] == "none", reply
        assert reply["headingFontSize"] >= reply["fontSize"], reply
        assert reply["multiAgentMode"] is False, reply
        assert not page_errors, f"browser errors: {page_errors}"
        browser.close()

    print(
        "Session lifecycle/FPS checks passed: completed and interrupted history seals, "
        f"active state stays live, reply typography {reply['fontSize']:.2f}px/"
        f"{reply['lineHeight']:.2f}px, 60-batch p95={frame_sample['p95Ms']:.2f}ms, "
        f"live-label animations {animation_model['legacyAnimations']} -> "
        f"{animation_model['currentAnimations']}"
    )


if __name__ == "__main__":
    main()

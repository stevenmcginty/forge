package com.forge.watch

import com.forge.watch.VoiceCommands.Command
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceCommandsTest {
    private val projects = listOf("forge", "car-harness", "Dealer Ledger Pro")
    private val profiles = listOf("Claude", "Codex", "PowerShell")

    private fun parse(text: String, draftEmpty: Boolean = true) =
        VoiceCommands.parse(text, draftEmpty, projects, profiles)

    @Test fun sendWords() {
        assertEquals(Command.Send, parse("send it."))
        assertEquals(Command.Send, parse("Go ahead"))
        assertEquals(Command.Send, parse("send", draftEmpty = false))
    }

    @Test fun cancelAndStop() {
        assertEquals(Command.Cancel, parse("scrap that"))
        assertEquals(Command.Cancel, parse("never mind", draftEmpty = false))
        assertEquals(Command.Stop, parse("stop listening"))
    }

    @Test fun openProject() {
        assertEquals(Command.OpenProject("forge"), parse("open forge"))
        assertEquals(Command.OpenProject("forge"), parse("Open the Forge project"))
        assertEquals(Command.OpenProject("car-harness"), parse("switch to car harness"))
        assertEquals(Command.OpenProject("Dealer Ledger Pro"), parse("go to dealer ledger"))
        // Recogniser mishears: same first letter, similar length.
        assertEquals(Command.OpenProject("forge"), parse("open fudge"))
    }

    @Test fun openUnknownIsText() {
        assertEquals(Command.Text("open the settings page and look at it"), parse("open the settings page and look at it"))
    }

    @Test fun newTab() {
        assertEquals(Command.NewTab(null), parse("new tab"))
        assertEquals(Command.NewTab(null), parse("Open a new tab."))
        assertEquals(Command.NewTab("Codex"), parse("new tab with codex"))
        assertEquals(Command.NewTab("Claude"), parse("start a new session using claude"))
        assertTrue(parse("new tab with something unknown") is Command.Text)
    }

    @Test fun tabs() {
        assertEquals(Command.SelectTab(2, null, 0), parse("tab two"))
        assertEquals(Command.SelectTab(2, null, 0), parse("tab 2"))
        assertEquals(Command.SelectTab(null, "login fix", 0), parse("go to tab login fix"))
        assertEquals(Command.SelectTab(null, null, 1), parse("next tab"))
        assertEquals(Command.SelectTab(null, null, -1), parse("previous tab"))
    }

    @Test fun commandsAreNotHonouredMidPrompt() {
        assertTrue(parse("open forge", draftEmpty = false) is Command.Text)
        assertTrue(parse("new tab", draftEmpty = false) is Command.Text)
        assertTrue(parse("tab two", draftEmpty = false) is Command.Text)
    }

    @Test fun terminalInSameBreath() {
        assertTrue(VoiceCommands.isTerminal("send it"))
        assertEquals("fix the login bug", VoiceCommands.stripTerminal("fix the login bug send it"))
        assertEquals("fix the login bug", VoiceCommands.stripTerminal("fix the login bug."))
    }
}

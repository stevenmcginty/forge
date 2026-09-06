package com.forge.watch

import com.forge.watch.VoiceCommands.Command
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceCommandsTest {
    private val projects = listOf("koraos", "DictationMic", "ac sprayers", "forge", "voice", "car-harness", "Dealer Ledger Pro")
    private val profiles = listOf("PowerShell", "Claude Code", "Codex", "Grok", "Kimi")

    private fun parse(text: String, draftEmpty: Boolean = true) =
        VoiceCommands.parse(text, draftEmpty, projects, profiles)

    @Test fun sendWords() {
        assertEquals(Command.Send, parse("send it."))
        assertEquals(Command.Send, parse("Go ahead"))
        assertTrue(parse("go") is Command.Text)
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
        assertEquals(Command.OpenProject("forge"), parse("go to Project Forge"))
        assertEquals(Command.OpenProject("ac sprayers"), parse("go to the project AC Sprayers"))
        assertEquals(Command.OpenProject("DictationMic"), parse("go to the project dictation mic"))
        assertEquals(Command.OpenProject("forge"), parse("open forge", draftEmpty = false))
    }

    @Test fun openUnknownIsText() {
        assertEquals(Command.Text("open the settings page and look at it"), parse("open the settings page and look at it"))
    }

    @Test fun newTab() {
        assertEquals(Command.NewTab(null, null), parse("new tab"))
        assertEquals(Command.NewTab(null, null), parse("Open a new tab."))
        assertEquals(Command.NewTab("Codex", null), parse("new tab with codex"))
        assertEquals(Command.NewTab("Claude Code", null), parse("start a new session using claude"))
        assertEquals(Command.NewTab("Grok", "voice"), parse("open up a Grok tab in Project Voice"))
        assertEquals(Command.NewTab(null, "forge"), parse("open a new tab in the Forge project"))
        assertEquals(Command.NewTab("Claude Code", "forge"), parse("new claude tab in forge"))
        assertTrue(parse("new tab with something unknown") is Command.Text)
    }

    @Test fun tabs() {
        assertEquals(Command.SelectTab(2, null, 0), parse("tab two"))
        assertEquals(Command.SelectTab(2, null, 0), parse("tab 2"))
        assertEquals(Command.SelectTab(null, "login fix", 0), parse("go to tab login fix"))
        assertEquals(Command.SelectTab(null, "ren", 0, "forge"), parse("go to tab Ren in Forge"))
        assertEquals(Command.SelectTab(null, null, 1), parse("next tab"))
        assertEquals(Command.SelectTab(null, null, -1), parse("previous tab"))
    }

    @Test fun closeTab() {
        assertEquals(Command.CloseTab(null, null, null), parse("close tab"))
        assertEquals(Command.CloseTab(null, null, null), parse("close this tab"))
        assertEquals(Command.CloseTab(null, null, null), parse("close the tab"))
        assertEquals(Command.CloseTab(null, null, null), parse("close current tab"))
        assertEquals(Command.CloseTab(2, null, null), parse("close tab two"))
        assertEquals(Command.CloseTab(2, null, null), parse("close tab 2"))
        assertEquals(Command.CloseTab(null, "login fix", null), parse("close tab login fix"))
        assertEquals(Command.CloseTab(2, null, "forge"), parse("close tab 2 in forge"))
        assertEquals(Command.CloseTab(null, null, "forge"), parse("close this tab in forge"))
        assertEquals(Command.CloseTab(null, null, null, others = true), parse("close other tabs"))
        assertEquals(Command.CloseTab(null, null, null, others = true), parse("close all other tabs"))
        assertEquals(Command.CloseTab(null, null, "forge", others = true), parse("close other tabs in forge"))
    }

    @Test fun yesIsOnlyEnterBeforeThePrompt() {
        assertEquals(Command.Enter, parse("yes"))
        assertTrue(parse("yes", draftEmpty = false) is Command.Text)
    }

    @Test fun danglingHalves() {
        assertTrue(VoiceCommands.isDangling("go to Project"))
        assertTrue(VoiceCommands.isDangling("open"))
        assertTrue(VoiceCommands.isDangling("new tab in"))
        assertTrue(VoiceCommands.isDangling("go to tab"))
        assertTrue(!VoiceCommands.isDangling("go to project forge"))
        assertEquals(Command.OpenProject("car-harness"), parse("go to Project car harness"))
    }

    @Test fun terminalInSameBreath() {
        assertTrue(VoiceCommands.isTerminal("send it"))
        assertEquals("fix the login bug", VoiceCommands.stripTerminal("fix the login bug send it"))
        assertEquals("fix the login bug", VoiceCommands.stripTerminal("fix the login bug."))
    }
}

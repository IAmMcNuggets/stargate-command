' STARGATE COMMAND :: silent launcher
' Starts the dialing computer with no console window. Double-click this, or
' point a desktop/Start Menu shortcut at it and give that shortcut a hotkey.

Dim sh, here
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = here
sh.Run "cmd /c node """ & here & "server.js""", 0, False

' Starts the dominAI launcher without showing a console window.
Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "node """ & here & "\launch.cjs""", 0, False

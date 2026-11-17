Option Explicit
' WanNengFanChang launcher - VBS edition (no SmartScreen prompt)
' Double-click this file: starts backend + opens Edge app window, same as the exe.

Dim shell, fso, here, nodeExe, serverPath, edgePath, url, i, tmpDir, args

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
serverPath = fso.BuildPath(here, "server.mjs")
url = "http://127.0.0.1:18321"

Function BackendUp()
  Dim h
  BackendUp = False
  On Error Resume Next
  Err.Clear
  Set h = CreateObject("MSXML2.XMLHTTP")
  h.open "GET", url & "/api/health", False
  h.send
  If Err.Number = 0 Then
    If h.Status = 200 Then
      If InStr(h.responseText, """ok"":true") > 0 Then BackendUp = True
    End If
  End If
  On Error GoTo 0
End Function

' 从 config.local.json 读取 node 路径；没有/无效则回退到 PATH 里的 node.exe
Function CfgNode()
  On Error Resume Next
  CfgNode = ""
  Dim p, ts, txt, re, mc
  p = fso.BuildPath(here, "config.local.json")
  If Not fso.FileExists(p) Then Exit Function
  Set ts = fso.OpenTextFile(p, 1, False)
  If Err.Number <> 0 Then Exit Function
  txt = ts.ReadAll
  ts.Close
  Set re = New RegExp
  re.Pattern = """node""\s*:\s*""([^""]*)"""
  Set mc = re.Execute(txt)
  If mc.Count > 0 Then CfgNode = mc(0).SubMatches(0)
  On Error GoTo 0
End Function

If Not BackendUp() Then
  nodeExe = CfgNode()
  If nodeExe = "" Or Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
  shell.CurrentDirectory = here
  shell.Run """" & nodeExe & """ """ & serverPath & """", 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If BackendUp() Then Exit For
  Next
End If

edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edgePath) Then edgePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
tmpDir = shell.ExpandEnvironmentStrings("%TEMP%") & "\wfc_browser_profile"
args = " --app=" & url & " --user-data-dir=""" & tmpDir & """ --window-size=1280,900 --window-position=80,60 --no-first-run --no-default-browser-check "
shell.Run """" & edgePath & """" & args, 1, False

; 应用内更新已经确认过。保留原安装范围，不重复询问；双范围并存时保留原选择页。
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${If} ${isUpdated}
    ${AndIf} ${isForceRun}
      ${If} $hasPerUserInstallation == "1"
      ${AndIf} $hasPerMachineInstallation == "0"
        StrCpy $isForceCurrentInstall "1"
      ${ElseIf} $hasPerMachineInstallation == "1"
      ${AndIf} $hasPerUserInstallation == "0"
        StrCpy $isForceMachineInstall "1"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; 仍显示 MUI_PAGE_INSTFILES。应用内更新完成后跳过结束页，由成功回调启动。
!macro customFinishPage
  Function FloworkFinishPre
    ${If} ${isUpdated}
    ${AndIf} ${isForceRun}
      Abort
    ${EndIf}
  FunctionEnd

  Function FloworkStartApp
    StrCpy $1 ""
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function .onInstSuccess
    ; 旧客户端的 /S 更新由 electron-builder 本身启动，不重复执行。
    ${IfNot} ${Silent}
    ${AndIf} ${isUpdated}
    ${AndIf} ${isForceRun}
      Call FloworkStartApp
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE FloworkFinishPre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION FloworkStartApp
  !insertmacro MUI_PAGE_FINISH
!macroend

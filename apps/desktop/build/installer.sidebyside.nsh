; Uninstall cleanup for the side-by-side test build.
;
; Mirrors build/installer.nsh but targets this build's own app-data folder
; (com.differentai.openwork.sxs) so uninstalling it can never read or delete
; files that belong to a normally-installed OpenWork (com.differentai.openwork).
!macro customUnInstall
  StrCpy $1 ""
  FileOpen $0 "$APPDATA\com.differentai.openwork.sxs\windows-brand-shortcut.txt" r
  IfErrors +3
    FileRead $0 $1
    FileClose $0
  ${If} $1 != ""
    Delete "$1"
  ${EndIf}
  Delete "$APPDATA\com.differentai.openwork.sxs\windows-brand-shortcut.txt"
!macroend

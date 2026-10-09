; electron-builder adds this file to the Windows installer and uninstaller.

; PowerPDF, HonoPDF and HonoKit up to 0.17.0 registered PDF files under the shared
; ProgID "PDF Document"; HonoKit now uses "HonoKit.PDF" (electron-builder.yml, win).
; Remove the old one, but only when one of these apps wrote it: its open verb is
; then named "Open with <app>". Left behind, it points at a deleted or older program.
;
; Pictures (decisions §75) are registered under "HonoKit.Image": HonoKit is listed in
; "Open with" (OpenWithProgids) but never made their default. electron-builder's
; association also writes the extension's default value, so it is taken back here,
; and the value another app had set there is put back (saved in customInit).
;
; "Edit with HonoKit" opens a PDF in the editor and a picture in the Photo editor
; (the --edit switch). It is a verb under SystemFileAssociations, so it shows whichever
; app is the default; a verb on our own ProgID would show only when HonoKit is the default.
; Windows 11 lists it under "Show more options". The uninstaller removes all of it.

!macro honokitEditVerb EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\HonoKit.Edit" "MUIVerb" "Edit with HonoKit"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\HonoKit.Edit" "Icon" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\HonoKit.Edit\command" "" '"$appExe" --edit "%1"'
!macroend

; electron-builder's APP_ASSOCIATE overwrites the extension's default (HKCU\Software\Classes\.jpg)
; without keeping what was there. So before it runs (customInit, in .onInit: interactive installs
; and silent updates alike) the default another app had set is saved under
; HKCU\Software\HonoKit\SavedTypes, and customInstall puts it back (decisions §76).
!define HONOKIT_SAVED "Software\HonoKit\SavedTypes"

!macro honokitSaveType EXT
  ReadRegStr $0 HKCU "Software\Classes\.${EXT}" ""
  StrCmp $0 "" honokit_save_done_${EXT}
  StrCmp $0 "HonoKit.Image" honokit_save_done_${EXT}
    WriteRegStr HKCU "${HONOKIT_SAVED}" "${EXT}" $0
  honokit_save_done_${EXT}:
!macroend

!macro honokitPictureType EXT
  ReadRegStr $0 HKCU "Software\Classes\.${EXT}" ""
  StrCmp $0 "HonoKit.Image" 0 honokit_type_done_${EXT}
    ; Ours: give back the default that was there before, or none.
    ReadRegStr $1 HKCU "${HONOKIT_SAVED}" "${EXT}"
    StrCmp $1 "" 0 +3
      DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
      Goto honokit_type_done_${EXT}
    WriteRegStr HKCU "Software\Classes\.${EXT}" "" $1
  honokit_type_done_${EXT}:
  !insertmacro honokitEditVerb "${EXT}"
!macroend

!macro honokitRemoveType EXT PROGID
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\HonoKit.Edit"
  DeleteRegKey /ifempty HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell"
  DeleteRegKey /ifempty HKCU "Software\Classes\SystemFileAssociations\.${EXT}"
  ; The extension's default, if it still names our ProgID, would point at nothing.
  ReadRegStr $0 HKCU "Software\Classes\.${EXT}" ""
  StrCmp $0 "${PROGID}" 0 +2
    DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
!macroend

!macro honokitPictureTypes MACRO
  !insertmacro ${MACRO} "jpg"
  !insertmacro ${MACRO} "jpeg"
  !insertmacro ${MACRO} "jfif"
  !insertmacro ${MACRO} "png"
  !insertmacro ${MACRO} "webp"
  !insertmacro ${MACRO} "gif"
  !insertmacro ${MACRO} "heic"
  !insertmacro ${MACRO} "heif"
  !insertmacro ${MACRO} "avif"
  !insertmacro ${MACRO} "tif"
  !insertmacro ${MACRO} "tiff"
  !insertmacro ${MACRO} "bmp"
  !insertmacro ${MACRO} "svg"
  !insertmacro ${MACRO} "ico"
  !insertmacro ${MACRO} "jxl"
!macroend

!macro honokitRemovePicture EXT
  !insertmacro honokitRemoveType "${EXT}" "HonoKit.Image"
!macroend

!macro customInit
  ; A key left by an install that was cancelled must not restore an older default.
  DeleteRegKey HKCU "${HONOKIT_SAVED}"
  !insertmacro honokitPictureTypes honokitSaveType
!macroend

!macro customInstall
  ReadRegStr $0 HKCU "Software\Classes\PDF Document\shell\open" ""
  StrCmp $0 "Open with PowerPDF" honokitRemoveOldProgId
  StrCmp $0 "Open with HonoPDF" honokitRemoveOldProgId
  StrCmp $0 "Open with HonoKit" honokitRemoveOldProgId honokitOldProgIdDone
  honokitRemoveOldProgId:
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PDF Document"
    DeleteRegKey HKCU "Software\Classes\PDF Document"
  honokitOldProgIdDone:
  !insertmacro honokitEditVerb "pdf"
  !insertmacro honokitPictureTypes honokitPictureType
  DeleteRegKey HKCU "${HONOKIT_SAVED}"
  DeleteRegKey /ifempty HKCU "Software\HonoKit"
  ; Tell Explorer the associations changed, so "Open with" updates without signing out.
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  !insertmacro honokitRemoveType "pdf" "HonoKit.PDF"
  !insertmacro honokitPictureTypes honokitRemovePicture
!macroend

; The app registers itself for peerpayload:// pairing links at startup
; (app.setAsDefaultProtocolClient, per user). Remove that on uninstall,
; so clicking such a link afterwards doesn't point at a missing program.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\peerpayload"
!macroend

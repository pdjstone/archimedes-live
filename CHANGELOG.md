# Archimedes Live Change log

This changelog covers the Arculator Live frontend, as well as subprojects such as arculator-wasm and the software catalog. 

## November 2024

* Mouse and keyboard input is now handled directly between JavaScript and Arculator, bypassing SDL input routines. This fixes several key mapping issues.
* The mouse can now move freely in/out of the emulator window without requiring "pointer lock". This works by directly poking mouse pointer coordinates into RISC OS memory. Some games require full control of the mouse, so arculator-wasm uses heuristics to detect when to capture the mouse (relative input). This can be overriden using the `mouse-capture` parameter (see [README.md](README.md)) 
* Fixed occasional glictchy audio when switching between software titles


## May 2023

* Initial full release

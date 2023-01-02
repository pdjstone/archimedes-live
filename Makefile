SHELL := /bin/bash

all: build/index.html build/arculator.js build/nspark/nspark.js build/emu

serve:
	python3 -m http.server -d build

clean:
	cd arculator-wasm && make clean && rm -rf emscripten_out
	rm -rf nspark-wasm/build
	rm -rf build

build:
	mkdir -p build

build/index.html: frontend build
	cp -r frontend/* build

build/arculator.js: arculator-wasm/emscripten_out/arculator.js build
	cp arculator-wasm/emscripten_out/arculator.{js,data,wasm} build

build/nspark/nspark.js: nspark-wasm/emscripten_out/nspark.js build
	mkdir -p build/nspark
	cp nspark-wasm/build/*.{js,wasm} build/nspark
	cp nspark-wasm/emscripten/*.js build/nspark

arculator-wasm/emscripten_out/arculator.js:
	touch arculator-wasm/arc.cfg # FIXME
	cd arculator-wasm && aclocal
	cd arculator-wasm && autoconf
	cd arculator-wasm && automake
	cd arculator-wasm && emconfigure ./configure --enable-debug --disable-podules
	cd arculator-wasm && emmake make

nspark-wasm/emscripten_out/nspark.js:
	mkdir -p nspark-wasm/build
	emcmake cmake -S nspark-wasm -B nspark-wasm/build
	emmake cmake --build nspark-wasm/build

build/emu:
	mkdir -p build/emu
	curl -s http://b-em.bbcmicro.com/arculator/Arculator_V2.1_Linux.tar.gz | tar xz -C build/emu/ roms cmos

#if [ -d "$SOFTWARE_DIR" ]; then
#    echo "Building software index from '$SOFTWARE_DIR' dir"
#     ./disctoml2json.py "$SOFTWARE_DIR" "$BUILD_DIR/software"
#    echo "Copying discs from $DISC_DIR"
#    mkdir $BUILD_DIR/discs
#    cp -r $SOFTWARE_DIR/* $BUILD_DIR/discs/
#    pushd .
#    cd $BUILD_DIR
#    find discs -type f > disc_index.txt
#    popd
#fi

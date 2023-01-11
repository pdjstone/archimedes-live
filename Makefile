SHELL := /bin/bash

all: build/index.html build/arculator.js build/nspark/nspark.js build/emu

serve:
	python3 -m http.server -d build

clean:
	cd arculator-wasm && make clean
	rm -rf nspark-wasm/build
	rm -rf build

build/index.html: frontend
	@mkdir -p $(@D)
	cp -r frontend/* build

build/arculator.js: arculator-wasm/build/wasm/arculator.js
	@mkdir -p $(@D)
	cp arculator-wasm/build/wasm/arculator.{js,data,data.js,wasm} build
ifdef DEBUG
	cp arculator-wasm/build/wasm/arculator.wasm.map build
endif

build/nspark/nspark.js: nspark-wasm/build/nspark.js
	@mkdir -p $(@D)
	cp nspark-wasm/build/*.{js,wasm} build/nspark/
	cp nspark-wasm/emscripten/*.js build/nspark/

arculator-wasm/build/wasm/arculator.js:
	touch arculator-wasm/arc.cfg # FIXME
	make -C arculator-wasm wasm

nspark-wasm/build/nspark.js:
	@mkdir -p nspark-wasm/build
	emcmake cmake -S nspark-wasm -B nspark-wasm/build
	emmake cmake --build nspark-wasm/build

build/emu: dlcache/arculator21.tar.gz
	mkdir -p build/emu
	tar xzf dlcache/arculator21.tar.gz -C build/emu/ roms cmos

dlcache/arculator21.tar.gz:
	mkdir -p dlcache
	curl -s http://b-em.bbcmicro.com/arculator/Arculator_V2.1_Linux.tar.gz --output dlcache/arculator21.tar.gz


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

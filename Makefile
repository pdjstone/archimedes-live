SHELL := /bin/bash

all: build/index.html build/arculator.js build/nspark/nspark.js build/emu build/software/software.json

serve:
	python3 -m http.server -d build

clean:
	cd arculator-wasm && make clean && rm -rf emscripten_out
	rm -rf nspark-wasm/build
	rm -rf build

catalogue: build build/software/software.json

build:
	mkdir -p build

build/index.html: frontend build
	cp -r frontend/* build

build/arculator.js: arculator-wasm/build/wasm/arculator.js build
	cp arculator-wasm/build/wasm/arculator.{js,data,data.js,wasm} build
ifdef DEBUG
	cp arculator-wasm/build/wasm/arculator.wasm.map build
endif

build/nspark/nspark.js: nspark-wasm/emscripten_out/nspark.js build
	mkdir -p build/nspark
	cp nspark-wasm/build/*.{js,wasm} build/nspark
	cp nspark-wasm/emscripten/*.js build/nspark

arculator-wasm/build/wasm/arculator.js:
	touch arculator-wasm/arc.cfg # FIXME
	cd arculator-wasm && make wasm

nspark-wasm/emscripten_out/nspark.js:
	mkdir -p nspark-wasm/build
	emcmake cmake -S nspark-wasm -B nspark-wasm/build
	emmake cmake --build nspark-wasm/build

build/emu: dlcache/arculator21.tar.gz
	mkdir -p build/emu
	tar xzf dlcache/arculator21.tar.gz -C build/emu/ roms cmos

dlcache/arculator21.tar.gz:
	mkdir -p dlcache
	curl -s http://b-em.bbcmicro.com/arculator/Arculator_V2.1_Linux.tar.gz --output dlcache/arculator21.tar.gz

build/software/software.json:
	arclive-software/toml2json.py arclive-software/catalogue/ build/software/



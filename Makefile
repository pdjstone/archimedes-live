SHELL := /bin/bash
BUILD_TAG_CMD := echo `git rev-parse --short HEAD`-`[[ -n $$(git status -s) ]] && echo 'dirty' || echo 'clean'`

BUILD_TAG := $(shell ${BUILD_TAG_CMD})
ARCULATOR_BUILD_TAG := $(shell cd arculator-wasm && ${BUILD_TAG_CMD})
NSPARK_BUILD_TAG := $(shell cd nspark-wasm && ${BUILD_TAG_CMD})
SOFTWARE_BUILD_TAG := $(shell cd arclive-software && ${BUILD_TAG_CMD})

# Everything the page loads goes in build/v/<build tag>/, and index.html points
# there. Modules, workers, the worklet and the wasm are all loaded by relative
# URLs, so each build is fetched under new URLs and its files never change:
# they can be cached for good, and only the top-level pages must be revalidated.
# A dirty tree's tag doesn't change as it's edited, so give it the time too.
ifneq (,$(findstring dirty,$(BUILD_TAG)))
  BUILD_TAG := $(BUILD_TAG)-$(shell date +%Y%m%d%H%M%S)
endif
VDIR := v/$(BUILD_TAG)
V := build/$(VDIR)
FRONTEND_FILES := $(shell find frontend -type f)
# Pages that stay at the top level, beside index.html
PAGES := $(filter-out frontend/index.template.html,$(wildcard frontend/*.html))

all: build/index.html build/emu build/emu/roms/arcrom_ext build/software/software.json

serve:
	python3 testserver.py

clean:
	cd arculator-wasm && make clean && rm -rf emscripten_out
	rm -rf nspark-wasm/build
	rm -rf build

catalogue: build build/software/software.json

build:
	mkdir -p build

build/index.html: $(V)/ui.js frontend/index.template.html $(PAGES)
	jinja2 -D VDIR=${VDIR} -D BUILD_TAG=${BUILD_TAG} -D ARCULATOR_BUILD_TAG=${ARCULATOR_BUILD_TAG} -D NSPARK_BUILD_TAG=${NSPARK_BUILD_TAG} -D SOFTWARE_BUILD_TAG=${SOFTWARE_BUILD_TAG} frontend/index.template.html < /dev/null > $@
	cp $(PAGES) build
	cp -r frontend/images build

# Only one version is kept locally; deploying adds it to those already there
$(V)/ui.js: $(FRONTEND_FILES) arculator-wasm/build/wasm/arculator.js nspark-wasm/build/nspark.js
	rm -rf build/v
	mkdir -p $(V)
	cp -r frontend/* $(V)
	rm $(V)/*.html
	cp arculator-wasm/js/frontend/*.js $(V)
	# Only the emulator worker loads the emulator and nspark
	mkdir -p $(V)/worker/nspark
	cp arculator-wasm/build/wasm/arculator.{js,wasm} $(V)/worker
ifdef DEBUG
	cp arculator-wasm/build/wasm/arculator.wasm.map $(V)/worker
endif
	cp nspark-wasm/build/*.{js,wasm} $(V)/worker/nspark
	cp nspark-wasm/emscripten/*.js $(V)/worker/nspark
	touch $@

arculator-wasm/build/wasm/arculator.js:
	cd arculator-wasm && make -j8 wasm

nspark-wasm/build/nspark.js:
	mkdir -p nspark-wasm/build
	emcmake cmake -S nspark-wasm -B nspark-wasm/build
	emmake cmake --build nspark-wasm/build

build/emu: dlcache/arculator22.tar.gz
	mkdir -p build/emu
	tar xzf dlcache/arculator22.tar.gz -C build/emu/ roms cmos

# Replace Arculator's extension ROM with the one built from arculator-wasm's
# HostFS modules
build/emu/roms/arcrom_ext: arculator-wasm/roms/arcrom_ext build/emu
	cp $< $@

# Always ask the submodule, which knows when the ROM is out of date
arculator-wasm/roms/arcrom_ext: FORCE
	cd arculator-wasm && make extnrom

FORCE:

dlcache/arculator22.tar.gz:
	mkdir -p dlcache
	curl -s https://b-em.bbcmicro.com/arculator/Arculator_V2.2_Linux.tar.gz --output dlcache/arculator22.tar.gz

build/software/software.json:
	arclive-software/toml2json.py arclive-software/catalogue/ build/software/

deploy: all
	s3cmd sync -m application/wasm --exclude '*.txt' build/emu/roms s3://files-archi.medes.live/
	cd build && s3cmd sync --no-mime-magic --guess-mime-type software s3://files-archi.medes.live
	cd build && s3cmd sync --no-mime-magic --guess-mime-type --add-header='Cache-Control: public, max-age=31536000, immutable' v s3://archi.medes.live/
	cd build && s3cmd sync --no-mime-magic --guess-mime-type --add-header='Cache-Control: no-cache' --exclude 'emu/*' --exclude 'software/*' --exclude 'v/*' --exclude 'survey/*' --exclude 'audio-dumps/*' . s3://archi.medes.live

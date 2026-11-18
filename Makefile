SHELL := /bin/bash

.PHONY: all frontend serve clean catalogue check deploy deploy-prune FORCE

# Run through uv, so no venv is needed
JINJA2 ?= uvx --from jinja2-cli==1.0.1 jinja2
PYTHON ?= python3

ARCULATOR_URL := https://b-em.bbcmicro.com/arculator/Arculator_V2.2_Linux.tar.gz
SITE_BUCKET := s3://archi.medes.live
FILES_BUCKET := s3://files-archi.medes.live
# Both buckets are in eu-west-2. s3cmd signs for us-east-1 unless told, and
# though ls and sync recover from that, get and info fail with a bare 400.
S3_REGION := eu-west-2
S3CMD ?= uvx s3cmd==2.4.0

# <short commit>-clean or <short commit>-dirty for the git checkout in $(1)
git_tag = $(shell cd $(1) && echo $$(git rev-parse --short HEAD)-$$([ -n "$$(git status -s)" ] && echo dirty || echo clean))

BUILD_TAG := $(call git_tag,.)
ARCULATOR_BUILD_TAG := $(call git_tag,arculator-wasm)
NSPARK_BUILD_TAG := $(call git_tag,nspark-wasm)
# A hash of the catalogue, which index.html gives the page to fetch it with
# (software.json?v=...). Expanded when index.html is made, after software.json
SOFTWARE_BUILD_TAG = $(shell sha256sum build/software/software.json 2>/dev/null | cut -c1-12)

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
CATALOGUE_FILES := $(shell find arclive-software/catalogue -type f)

JINJA_VARS = $(foreach v,VDIR BUILD_TAG ARCULATOR_BUILD_TAG NSPARK_BUILD_TAG SOFTWARE_BUILD_TAG,-D $(v)=$($(v)))

ARCULATOR_JS := arculator-wasm/build/wasm/arculator.js
NSPARK_JS := nspark-wasm/build/nspark.js
# The RISC OS modules the worker builds support ROMs from (SUPPORT_MODULES in
# frontend/shared/machines.js), in the order the submodule's ROM has them.
# Building that ROM (for the native build) builds them
EXTNROM := arculator-wasm/roms/arcrom_ext
EXTNROM_MODULES := arculator-wasm/src/hostfs/hostfs,ffa arculator-wasm/src/hostfs/hostfsfiler,ffa \
	arculator-wasm/src/jscli/jscli,ffa arculator-wasm/src/jscli/jscliwimp,ffa

all: build/index.html build/emu build/software/software.json

# EMSCRIPTEN_VERSION and check-emcc, shared with the emulator's build
include arculator-wasm/emscripten.mk

# Just the page and its code, using the emulator and nspark already built
frontend: build/index.html

serve:
	$(PYTHON) testserver.py

clean:
	$(MAKE) -C arculator-wasm clean
	rm -rf arculator-wasm/emscripten_out nspark-wasm/build build

catalogue: build/software/software.json

# A new catalogue needs a new index.html for its hash, but `make frontend`
# leaves the catalogue alone and uses the hash of the one already built
ifeq (,$(filter frontend,$(MAKECMDGOALS)))
build/index.html: build/software/software.json
endif

build/index.html: $(V)/ui.js frontend/index.template.html $(PAGES)
	$(JINJA2) $(JINJA_VARS) frontend/index.template.html < /dev/null > $@
	cp $(PAGES) build
	cp -r frontend/images build

# Only one version is kept locally; deploying adds it to those already there.
# images/ goes in both places: style.css loads it relative to itself, and the
# top-level pages relative to themselves.
$(V)/ui.js: $(FRONTEND_FILES) $(ARCULATOR_JS) $(NSPARK_JS) $(EXTNROM)
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
	mkdir -p $(V)/worker/extnrom
	cp $(EXTNROM_MODULES) $(V)/worker/extnrom
	touch $@

# The emulator and nspark are always handed to their own builds, which know
# when they're out of date; $(V) is only remade if their output changes.
# `make frontend` skips them.
ifeq (,$(filter frontend,$(MAKECMDGOALS)))
$(ARCULATOR_JS): FORCE
$(NSPARK_JS): FORCE
$(EXTNROM): FORCE
endif

$(ARCULATOR_JS):
	$(MAKE) -C arculator-wasm wasm

nspark-wasm/build/CMakeCache.txt: | check-emcc
	emcmake cmake -S nspark-wasm -B nspark-wasm/build

$(NSPARK_JS): nspark-wasm/build/CMakeCache.txt | check-emcc
	emmake cmake --build nspark-wasm/build

build/emu: dlcache/arculator22.tar.gz
	mkdir -p $@
	tar xzf $< -C $@ roms cmos

$(EXTNROM):
	$(MAKE) -C arculator-wasm extnrom

# The worker's support ROM builder makes the same ROM as the submodule's script
check: $(EXTNROM)
	node --experimental-detect-module tools/check_extnrom.mjs $(EXTNROM) $(EXTNROM_MODULES)

FORCE:

dlcache/arculator22.tar.gz:
	mkdir -p dlcache
	curl -fsSL $(ARCULATOR_URL) -o $@.tmp
	mv $@.tmp $@

# Made afresh each time, so build/software holds only what the catalogue uses.
# make REFRESH=1 fetches every file again (toml2json.py --refresh), taking new
# versions that check out, so it runs even if the catalogue hasn't changed
build/software/software.json: $(CATALOGUE_FILES) arclive-software/toml2json.py $(if $(REFRESH),FORCE)
	rm -rf build/software
	arclive-software/toml2json.py $(if $(REFRESH),--refresh) arclive-software/catalogue/ build/software/

S3SYNC := $(S3CMD) --region $(S3_REGION) sync --no-mime-magic --guess-mime-type

# The pages and catalogue that were live before the upload, so what they use
# is kept for pages already open. Not in build/, which is uploaded.
DEPLOY_LIVE := dlcache/deploy-live
PRUNE := $(PYTHON) tools/prune_deploy.py --s3cmd '$(S3CMD) --region $(S3_REGION)' $(if $(DRY_RUN),--dry-run)

# After uploading, deletes the files that neither the new build nor the one
# it replaces uses: old software versions from the files bucket, and old v/
# directories from the site. `make deploy-prune DRY_RUN=1` lists them.
deploy: all
	rm -rf $(DEPLOY_LIVE) && mkdir -p $(DEPLOY_LIVE)
	$(S3CMD) --region $(S3_REGION) get $(FILES_BUCKET)/software/software.json $(DEPLOY_LIVE)/software.json
	$(S3CMD) --region $(S3_REGION) get $(SITE_BUCKET)/index.html $(DEPLOY_LIVE)/index.html
	$(S3CMD) --region $(S3_REGION) sync -m application/octet-stream --exclude '*.txt' build/emu/roms $(FILES_BUCKET)/
	cd build && $(S3SYNC) software $(FILES_BUCKET)
	cd build && $(S3SYNC) --add-header='Cache-Control: public, max-age=31536000, immutable' v $(SITE_BUCKET)/
	cd build && $(S3SYNC) --add-header='Cache-Control: no-cache' --exclude 'emu/*' --exclude 'software/*' --exclude 'v/*' --exclude 'survey/*' --exclude 'audio-dumps/*' . $(SITE_BUCKET)
	$(MAKE) deploy-prune

deploy-prune:
	$(PRUNE) software $(FILES_BUCKET)/software/ build/software/software.json $(DEPLOY_LIVE)/software.json
	$(PRUNE) versions $(SITE_BUCKET)/v/ build/index.html $(DEPLOY_LIVE)/index.html

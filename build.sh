#!/bin/bash

# TODO: replace with Webpack or whatever the kids use these days

source ./build-vars.sh

BUILD_DIR=build

if [ -d "$BUILD_DIR" ]; then
    rm -rf $BUILD_DIR
fi

mkdir $BUILD_DIR
if [ ! -d "$BUILD_DIR" ]; then
    echo "failed to create build dir"
    exit -1
fi

# Copy static frontend files to build dir
cp -r frontend/* $BUILD_DIR

# Copy Arculator WASM build
if [ ! -d "$ARCULATOR_WASM/emscripten_out" ]; then
    echo "Cannot find Arculator-WASM build directory"
    exit -1
fi
cp $ARCULATOR_WASM/emscripten_out/arculator.{js,data,wasm} $BUILD_DIR/

# Create 'emu' dir for static files that Arculator may use
mkdir $BUILD_DIR/emu/

 # Copy ROMS and CMOS presets from Arculator release build
if [ ! -d "$ARCULATOR_RELEASE" ]; then
    echo "Cannot find arculator release build directory: $ARCULATOR_RELEASE"
    echo "Set \$ARCULATOR_RELEASE to point to this"
    exit -1
fi
cp -r $ARCULATOR_RELEASE/cmos $BUILD_DIR/emu/
cp -r $ARCULATOR_RELEASE/roms $BUILD_DIR/emu/

if [ -d "$SOFTWARE_DIR" ]; then 
    echo "Building software index from '$SOFTWARE_DIR' dir"
     ./disctoml2json.py "$SOFTWARE_DIR" "$BUILD_DIR/software"
    echo "Copying discs from $DISC_DIR"
    mkdir $BUILD_DIR/discs
    cp -r $SOFTWARE_DIR/* $BUILD_DIR/discs/
    pushd .
    cd $BUILD_DIR
    find discs -type f > disc_index.txt
    popd
fi

if [ ! -d "$NSPARK_DIR" ]; then
    echo "Please set NSPARK_DIR"
    exit -1 
fi 

if [ ! -f "$NSPARK_DIR/build/nspark.wasm" ]; then
    echo "Please build nspark"
    exit -1
fi

mkdir "$BUILD_DIR/nspark"
cp "$NSPARK_DIR"/build/*.{js,wasm} "$BUILD_DIR/nspark/"
cp "$NSPARK_DIR"/emscripten/*.js "$BUILD_DIR/nspark/"


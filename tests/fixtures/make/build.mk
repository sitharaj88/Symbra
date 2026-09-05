# Build tasks for the service.

CC := gcc
BIN_DIR ?= build
SOURCES = $(wildcard src/*.c)
VERSION != git describe --tags

include scripts/common.mk
-include local.mk

.PHONY: all test clean release

# Build everything.
all: $(BIN_DIR)/app docs

$(BIN_DIR)/app: $(SOURCES)
	$(CC) -o $@ $^ -DDEPLOY_ENV=$(DEPLOY_ENV)

# Run the test suite.
test: all
	./run-tests.sh

docs:
	$(MAKE) -C docs html

release: test docs
	$(MAKE) publish

publish:
	./publish.sh

clean:
	rm -rf $(BIN_DIR)

%.o: %.c
	$(CC) -c $< -o $@

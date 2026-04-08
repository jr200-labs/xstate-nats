VERSION := $(shell node -p "require('./package.json').version")

.PHONY: all install update check test test-watch build bump release clean publish

all: check

install:
	pnpm install

update:
	pnpm update --latest

check:
	pnpm run prettier --write
	pnpm run lint

test:
	pnpm test

test-watch:
	pnpm test:watch

build:
	pnpm build

bump:
	@if [ -z "$(PART)" ]; then echo "Usage: make bump PART=major|minor|patch"; exit 1; fi
	@IFS='.' read -r major minor patch <<< "$(VERSION)"; \
	case "$(PART)" in \
		major) major=$$((major + 1)); minor=0; patch=0;; \
		minor) minor=$$((minor + 1)); patch=0;; \
		patch) patch=$$((patch + 1));; \
		*) echo "PART must be major, minor, or patch"; exit 1;; \
	esac; \
	new_version="$$major.$$minor.$$patch"; \
	node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.version='$$new_version'; fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"; \
	echo "Bumped version: $(VERSION) -> $$new_version"

release: check build
	@echo "Creating release v$(VERSION)..."
	git tag "v$(VERSION)"
	git push origin "v$(VERSION)"
	gh release create "v$(VERSION)" --generate-notes

clean:
	rm -rf dist

publish: build test
	pnpm publish

SLUG = merkle-providence-reverse-rag-whitepaper
VENV = venv
PIP = $(VENV)/bin/pip
RST2PDF = $(VENV)/bin/rst2pdf

all: $(SLUG).pdf

$(VENV):
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install rst2pdf

$(SLUG).pdf: $(SLUG).rst whitepaper.style $(VENV)
	$(RST2PDF) $(SLUG).rst -s whitepaper.style -o $(SLUG).pdf

clean:
	rm -f $(SLUG).pdf

clean-all: clean
	rm -rf $(VENV)

pdf: $(SLUG).pdf

.PHONY: all clean clean-all pdf

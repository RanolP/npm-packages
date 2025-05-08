from sys import argv
from pathlib import Path
import json
import fontforge

def normalize_font_name(old_name: str) -> str:
    new_name = {
        # Serif
        'NewComputerModern08': 'WebCM Serif 08',
        'NewComputerModern10': 'WebCM Serif 10',

        # Sans
        'NewComputerModernSans08': 'WebCM Sans 08',
        'NewComputerModernSans10': 'WebCM Sans 10',

        # Mono
        'NewComputerModernMono10': 'WebCM Mono 10',

        # Devanagari
        'NewCM08Devanagari': 'WebCM Devanagari 08',
        'NewComputerModern 10 Devanagari': 'WebCM Devanagari 10',

        # Uncial
        'NewCMUncial08': 'WebCM Uncial 08',
        'NewComputerModernUncial10': 'WebCM Uncial 08',
        'NewCMUncial10': 'WebCM Uncial 10',

        # Math
        'NewComputerModernSansMath': 'WebCM Math Sans',
        'NewComputerModernMath': 'WebCM Math Serif',
    }.get(old_name, None)

    if new_name is None:
        new_name = old_name.replace('NewComputerModern', 'WebCM').replace('NewCM', 'WebCM').replace('NewComputerRoman', 'WebCM')
        print(json.dumps({"type":"warn","msg":f"{old_name} -> {new_name} by approximation."}))

    return new_name

otf_file = argv[1]

font = fontforge.open(otf_file)

subfamily = next(x[2] for x in font.sfnt_names if x[0] == 'English (US)' and x[1] == 'SubFamily')

# Rename per GFL request
font.familyname = normalize_font_name(font.familyname)
font.fullname = f"{font.familyname} {subfamily}"
font.appendSFNTName('English (US)', 'PostScriptName', font.fullname.replace(' ', '-'))

# Fix weights
expected_weight = {
    # Bold
    'Bold': 700,
    'BoldOblique': 700,
    'BoldItalic': 700,

    # Book
    'Book': 500,
    'BookOblique': 500,
    'BookItalic': 500,

    # Regular
    'Regular': 400,
    'Oblique': 400,
    'Italic': 400,
}.get(subfamily, None)

if expected_weight is None:
    print(json.dumps({"type":"warn","message":f"There is no expected weight for {font.fullname} (got weight={font.os2_weight})"}))
elif expected_weight != font.os2_weight:
    print(json.dumps({"type":"warn","msg":f'Expected weight={expected_weight} for {font.fullname} but got weight={font.os2_weight}'}))
    print(json.dumps({"type":"fix","msg":f'{font.fullname}: change font weight from {font.os2_weight} to {expected_weight}'}))
    font.os2_weight = expected_weight

woff2_file = f"woff2/{font.fullname}.woff2"
print(json.dumps({"type":"done","file":woff2_file}))

font.generate(woff2_file)

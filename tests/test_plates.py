import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "platform"))

from uvp.plates import correct, is_valid, levenshtein, normalise  # noqa: E402


def test_valid_formats():
    for p in ["MH12AB1234", "DL3CAF0921", "KA05M1234", "DL1C1234", "22BH1234AA", "TN01AB0001"]:
        assert is_valid(p), p
    for p in ["XX12AB1234", "MH12AB123", "1234", "MH12ABCD1234"]:
        assert not is_valid(p), p


def test_normalise():
    assert normalise("mh 12-ab 1234") == "MH12AB1234"


def test_positional_correction():
    assert correct("MH12A81234").plate == "MH12AB1234"   # 8 -> B in series position
    assert correct("TSO9EZ4521").plate == "TS09EZ4521"   # O -> 0 in RTO position
    assert correct("MHI2AB1234").plate == "MH12AB1234"   # I -> 1
    assert correct("DL3CAFO921").plate == "DL3CAF0921"   # O -> 0 in number
    fix = correct("GJ01KL5566")
    assert fix.valid and fix.corrections == 0


def test_unfixable_stays_invalid():
    assert not correct("K00MMN778").valid


def test_levenshtein():
    assert levenshtein("MH12AB1234", "MH12AB1234") == 0
    assert levenshtein("MH12AB1234", "MH12AB1284") == 1
    assert levenshtein("MH12AB1234", "MH12AB124") == 1


def test_single_digit_rto_only_for_delhi():
    assert is_valid("DL3CAF0921")
    assert not is_valid("HP0ZZR7493")
    assert correct("HP0ZZR7493").plate == "HP02ZR7493"


def test_home_state_prior():
    from uvp.plates import home_state_fix
    assert home_state_fix("HP04ZR7493", [0.6] * 10, ["MP"]) == "MP04ZR7493"   # unsure H -> M
    assert home_state_fix("HP04ZR7493", [0.99] * 10, ["MP"]) == "MP04ZR7493"  # default: always prefer home
    assert home_state_fix("HP04ZR7493", [0.99] * 10, ["MP"], max_conf=0.95) == "HP04ZR7493"  # strict mode
    assert home_state_fix("KA05MN7788", [0.5] * 10, ["MP"]) == "KA05MN7788"   # not a look-alike


def test_trim_stray_characters():
    from uvp.plates import trim_to_plate
    assert trim_to_plate("OMP04ZR7493") == "MP04ZR7493"    # emoji read as O
    assert trim_to_plate("MP04ZR7493I") == "MP04ZR7493"    # bolt read as I
    assert trim_to_plate("MP04ZR7493") == "MP04ZR7493"


def test_emoji_inside_and_row_order():
    from uvp.plates import trim_to_plate
    assert trim_to_plate("MP04OSH7288") == "MP04SH7288"     # sticker between the rows read as O
    assert trim_to_plate("OSH7288MP04") == "MP04SH7288"     # bottom row first + sticker
    assert trim_to_plate("MP04ZR7493") == "MP04ZR7493"


def test_best_effort_for_unreadable_plates():
    from uvp.plates import trim_to_plate
    assert trim_to_plate("OSHTEERMPO4").startswith("MP04")    # emoji O gone, state code first

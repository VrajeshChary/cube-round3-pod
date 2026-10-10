from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field, model_validator

from ..utils import is_non_product_media

logger = logging.getLogger(__name__)


class VisionEvidence(BaseModel):
    has_image: bool = Field(default=False, description="Whether an image was provided for visual inspection")
    image_quality: str = Field(default="good", description="good, blurry, dark, obstructed, tiny, corrupted, unusable")
    is_product: Optional[bool] = Field(default=True, description="Whether the image shows a recognizable returned product")
    product_identity: Optional[str] = Field(default=None, description="Observed product name/type")
    expected_product_match: Optional[bool] = Field(default=None, description="Whether observed matches expected product")
    observed_product: Optional[str] = Field(default=None, description="Detailed observable product description")
    observed_components: List[str] = Field(default_factory=list, description="Explicitly visible components")
    expected_components: List[str] = Field(default_factory=list, description="Authoritative expected components")
    missing_components: List[str] = Field(default_factory=list, description="Authoritative missing components")
    condition: Optional[str] = Field(default=None, description="Observed condition: new, used_like_new, used_good, damaged, uncertain")
    damage_description: Optional[str] = Field(default=None, description="Description of visible damage if any")
    ambiguity: Optional[str] = Field(default=None, description="Ambiguous elements, conflicts, obscurations")
    confidence: float = Field(default=0.90, ge=0.0, le=1.0, description="Visual assessment confidence score")
    recommended_reason_category: Optional[str] = Field(default=None, description="One of the 8 canonical rule categories")

    # Backward compatibility attributes
    physical_product_detected: Optional[bool] = Field(default=None, description="Whether a physical product was detected")
    detected_product: Optional[str] = Field(default=None, description="Observable product name/description")
    detected_brand: Optional[str] = Field(default=None, description="Brand name visible on packaging/label")
    visible_parts: List[str] = Field(default_factory=list, description="Explicitly visible components")
    missing_candidates: List[str] = Field(default_factory=list, description="Empty cavities or unreturned parts")
    conflicting_parts: List[str] = Field(default_factory=list, description="Components with conflicting evidence across multiple photos")
    visible_damage: List[str] = Field(default_factory=list, description="Directly observable scratches, dents, fractures, or stains")
    packaging_state: Optional[str] = Field(default=None, description="factory_sealed, opened_unused, signs_of_use, damaged, uncertain")
    uncertainty_notes: Optional[str] = Field(default=None, description="Ambiguous elements, glare, obscurations")
    inference_source: Optional[str] = Field(default="offline_uncertainty", description="Provider and model used for inference")
    model_used: Optional[str] = Field(default=None, description="Exact multimodal model and provider used")
    image_analyzed: Optional[str] = Field(default=None, description="Descriptor of image analyzed")
    images_analyzed: List[str] = Field(default_factory=list, description="List of image descriptors analyzed")
    vision_confidence: Optional[float] = Field(default=None, description="Normalized vision confidence score")
    detected_evidence: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Structured dictionary of detected physical evidence")
    is_gemini_inference: bool = Field(default=False, description="True if response came from Gemini Multimodal Vision")
    is_fallback: bool = Field(default=False, description="True if fallback / offline failure state was used")

    @model_validator(mode="after")
    def sync_compatibility_fields(self) -> VisionEvidence:
        if self.observed_components and not self.visible_parts:
            self.visible_parts = list(self.observed_components)
        elif self.visible_parts and not self.observed_components:
            self.observed_components = list(self.visible_parts)

        if self.missing_components and not self.missing_candidates:
            self.missing_candidates = list(self.missing_components)
        elif self.missing_candidates and not self.missing_components:
            self.missing_components = list(self.missing_candidates)

        if self.product_identity and not self.detected_product:
            self.detected_product = self.product_identity
        elif self.detected_product and not self.product_identity:
            self.product_identity = self.detected_product

        if self.observed_product and not self.detected_product:
            self.detected_product = self.observed_product

        if self.damage_description and not self.visible_damage:
            self.visible_damage = [self.damage_description]
        elif self.visible_damage and not self.damage_description:
            self.damage_description = "; ".join(str(d) for d in self.visible_damage)

        if self.vision_confidence is None:
            self.vision_confidence = self.confidence
        return self


def _build_vision_prompt(catalog_product: Optional[Any], num_images: int = 1) -> str:
    """Builds the canonical generic multimodal prompt for returns inspection."""
    if catalog_product:
        expected_title = catalog_product.title
        expected_sku = catalog_product.sku
        expected_parts_list = catalog_product.expected_parts if catalog_product.expected_parts else []
    else:
        expected_title = "Unknown / General Merchandise"
        expected_sku = "Unknown"
        expected_parts_list = []

    expected_parts_str = ", ".join(f'"{p}"' for p in expected_parts_list) if expected_parts_list else ""

    instructions_header = (
        f"You are an expert Warehouse Vision Evidence Inspector for customer returns.\n"
        f"Analyze the actual product visible in the supplied image{'s' if num_images > 1 else ''}. "
        f"Do not assume a particular product category. Do not infer product identity from filenames. "
        f"Do not assume the item is a lamp. Evaluate whatever product is actually visible."
    )

    return f"""{instructions_header}

CRITICAL INSPECTION RULES:
1. Image Quality:
   - Identify whether the image is clear, blurry, dark, obstructed, tiny, corrupted, or unusable before making product-condition conclusions.
   - If the image is too blurry, dark, or obstructed to reliably inspect the item, set image_quality to "blurry" or "unusable". Do NOT guess the product condition from an unusable image.
2. Is Product:
   - Determine if the image shows a recognizable returned product (is_product=true), vs non-product media (is_product=false) such as a wall, floor, random scenery, unrelated object, screenshot, document, logo, etc.
3. Product Identity & Expected Product Match:
   - Describe what is physically visible (observed_product and product_identity).
   - If an Expected Product is specified below, evaluate if the observed product matches it. If the image clearly shows a different product than expected, set expected_product_match=false.
4. Completeness:
   - Compare observed components against authoritative expected components when supplied below. Do not invent or hallucinate expected components if none are specified.
   - List missing components only if an authoritative expected component is confirmed absent or empty cavity is seen.
5. Condition & Damage:
   - Classify condition as "new", "used_like_new", "used_good", "damaged", or "uncertain".
   - If visibly broken or damaged beyond acceptable resale condition, describe the damage in damage_description.
6. Multi-image & Ambiguity:
   {"- Reconcile evidence across all " + str(num_images) + " photos. If photos contradict one another or belong to different products and cannot be resolved reliably, record the discrepancy in ambiguity rather than guessing." if num_images > 1 else "- If product identity or condition cannot be determined with certainty, record details in ambiguity."}
7. Recommended Reason Category:
   - Select exactly one of: "correct_product", "wrong_product", "damaged_product", "missing_component", "blurry_image", "unusable_image", "non_product_image", "ambiguous_multi", "api_failure".

EXPECTED REFERENCE (from order details):
- Expected Product Title: {expected_title}
- Expected SKU: {expected_sku}
- Authoritative Expected Components: [{expected_parts_str}]

Respond ONLY with a valid JSON object matching this schema:
{{
  "image_quality": "good",
  "is_product": true,
  "product_identity": "name of observed product",
  "expected_product_match": true,
  "observed_product": "detailed description of visible product",
  "observed_components": ["visible parts"],
  "expected_components": [{expected_parts_str}],
  "missing_components": [],
  "condition": "new",
  "damage_description": null,
  "ambiguity": null,
  "confidence": 0.95,
  "recommended_reason_category": "correct_product"
}}
"""


class VisionConfig:
    """Single authoritative configuration loader for Vision AI providers and credentials."""

    def __init__(self):
        self.env_loaded = False
        self.env_path = "not_found"

        if os.environ.get("GEMINI_OFFLINE") == "1":
            self.provider = "offline"
            self.api_key = None
            self.active_model = "none"
            self.openrouter_key = None
            self.gemini_key = None
            self.api_key_preview = None
            return

        self._load_env()

        self.openrouter_key = os.environ.get("OPENROUTER_API_KEY")
        self.gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        self.configured_vision_model = os.environ.get("VISION_MODEL")
        self.configured_vision_provider = os.environ.get("VISION_PROVIDER")

        active_key = self.openrouter_key or self.gemini_key
        if active_key:
            self.api_key_preview = "configured"
        else:
            self.api_key_preview = None

        if (self.configured_vision_provider == "gemini" or not self.openrouter_key) and self.gemini_key:
            self.provider = "Google GenAI"
            self.api_key = self.gemini_key
            self.active_model = self.configured_vision_model or os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash"
        elif self.openrouter_key:
            self.provider = "OpenRouter"
            self.api_key = self.openrouter_key
            req_model = self.configured_vision_model or os.environ.get("OPENROUTER_MODEL") or "google/gemini-3.5-flash"
            self.active_model = req_model
        elif self.gemini_key:
            self.provider = "Google GenAI"
            self.api_key = self.gemini_key
            self.active_model = self.configured_vision_model or os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash"
        else:
            self.provider = "offline"
            self.api_key = None
            self.active_model = "none"

    def _load_env(self):
        try:
            import dotenv
            env_file = Path(__file__).resolve().parent.parent.parent / ".env"
            if env_file.exists():
                dotenv.load_dotenv(dotenv_path=env_file, override=False)  # real env (CI, tests) wins over .env
                self.env_loaded = True
                self.env_path = str(env_file)
            else:
                dotenv.load_dotenv(override=False)
                self.env_loaded = True
                self.env_path = "default_env"
        except ImportError:
            pass


class VisionAgent:
    def __init__(self, model_version: str = "vision-evidence-agent-v3.0"):
        self.model_version = model_version
        self.client = None
        self.config = VisionConfig()

        self.provider = self.config.provider
        self.active_model = self.config.active_model
        self.api_key = self.config.api_key
        self.env_loaded = self.config.env_loaded
        self.env_path = self.config.env_path

        if self.provider == "Google GenAI" and self.api_key:
            try:
                from google import genai
                self.client = genai.Client(api_key=self.api_key)
                logger.info(f"VisionAgent: Active multimodal provider Google GenAI (model: {self.active_model})")
            except Exception as e:
                logger.warning(f"VisionAgent: Failed to initialize Google GenAI Client: {e}")
                self.provider = "offline"
                self.active_model = "none"
        elif self.provider == "OpenRouter":
            logger.info(f"VisionAgent: Active multimodal provider OpenRouter with Google Gemini (model: {self.active_model})")
        else:
            logger.info("VisionAgent: No API key found. Operating in strict offline development failure mode (no fake observations).")

    def check_env_loading(self) -> Dict[str, Any]:
        """Inspects and returns detailed status of .env loading and API keys."""
        return {
            "env_loaded": self.config.env_loaded or (self.config.env_path != "not_found"),
            "env_path": self.config.env_path,
            "openrouter_key_present": bool(self.config.openrouter_key),
            "gemini_key_present": bool(self.config.gemini_key),
            "api_key_preview": self.config.api_key_preview,
            "configured_vision_model": self.config.configured_vision_model,
            "configured_vision_provider": self.config.configured_vision_provider,
        }

    def get_setup_status(self) -> Dict[str, Any]:
        """Safe setup check showing whether Gemini Vision is active."""
        is_gemini_active = (self.provider != "offline" and ("gemini" in self.active_model.lower() or self.provider == "Google GenAI"))
        return {
            "status": "ready" if self.provider != "offline" else "offline",
            "gemini_vision_active": is_gemini_active,
            "multimodal_vision_active": self.provider != "offline",
            "provider": self.provider,
            "model": self.active_model,
            "api_key_configured": bool(self.api_key),
            "api_key_preview": self.config.api_key_preview,
            "env_loaded": self.config.env_loaded,
            "env_path": self.config.env_path,
            "evidence_mode": "live_gemini_multimodal_inference" if is_gemini_active else ("live_multimodal_inference" if self.provider != "offline" else "offline_uncertainty_only"),
            "mock_fallback": "disabled (uncertainty failure state only)",
            "fake_fallback_enabled": False,
        }

    def _inspect_image_quality(
        self,
        image_bytes: Optional[bytes],
        image_filename: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Analyzes image bytes using PIL to detect blank, placeholder, or severely blurred images."""
        if not image_bytes:
            return None

        try:
            from PIL import Image, ImageFilter, ImageStat

            img = Image.open(io.BytesIO(image_bytes))
            width, height = img.size

            if width < 16 or height < 16:
                return {
                    "reason": f"Image is a placeholder pixel ({width}x{height}px); no visual product features observable.",
                    "confidence": 0.20,
                }

            stat = ImageStat.Stat(img)
            if max(stat.var) < 1.0:
                return {
                    "reason": "Image is blank or a uniform solid color; no physical product features observable.",
                    "confidence": 0.20,
                }

            gray = img.convert("L")
            edges = gray.filter(ImageFilter.FIND_EDGES)
            edge_var = ImageStat.Stat(edges).var[0]
            if edge_var < 15.0:
                return {
                    "reason": f"Image is severely blurred or featureless (edge variance {edge_var:.1f}); cannot identify product or assess condition.",
                    "confidence": 0.25,
                }

            return None
        except Exception as exc:
            logger.warning(f"Error inspecting image quality with PIL: {exc}")
            return {
                "reason": f"Corrupted or unreadable image file ({exc}); manual inspection required.",
                "confidence": 0.15,
            }

    def _parse_vision_response_dict(
        self,
        result_dict: Dict[str, Any],
        images_data: Optional[List[Tuple[bytes, str, str]]] = None,
        image_bytes: Optional[bytes] = None,
        image_filename: Optional[str] = None,
        mime_type: str = "image/jpeg",
        elapsed_ms: int = 0,
    ) -> VisionEvidence:
        """Shared parser that maps multimodal JSON output into a validated VisionEvidence record."""
        if images_data is None:
            images_data = [(image_bytes, mime_type, image_filename or "uploaded_image")] if image_bytes else []

        images_analyzed = [fname for (_, _, fname) in images_data]
        image_analyzed_str = (
            ", ".join(Path(f).name for f in images_analyzed)
            if images_analyzed
            else (image_filename or "uploaded_image")
        )

        result_dict["has_image"] = True
        is_gemini = "gemini" in self.active_model.lower()
        result_dict["model_used"] = f"{self.active_model} ({self.provider})"
        result_dict["images_analyzed"] = images_analyzed
        result_dict["image_analyzed"] = image_analyzed_str
        result_dict["vision_confidence"] = float(result_dict.get("confidence", 0.95))

        # Check for non-product media ONLY from observed text/descriptions, NEVER from filenames
        observed_text = f"{result_dict.get('observed_product', '')} {result_dict.get('product_identity', '')} {result_dict.get('detected_product', '')} {result_dict.get('uncertainty_notes', '')} {result_dict.get('ambiguity', '')}"
        is_non_prod_by_text = is_non_product_media(observed_text)
        is_prod_val = result_dict.get("is_product")
        if is_prod_val is not None:
            is_product_bool = bool(is_prod_val) and not is_non_prod_by_text
        else:
            is_product_bool = not is_non_prod_by_text
        result_dict["is_product"] = is_product_bool
        result_dict["physical_product_detected"] = is_product_bool

        # Reconcile components across observed and missing lists
        observed_components = [p for p in (result_dict.get("observed_components") or result_dict.get("visible_parts") or []) if isinstance(p, str)]
        raw_missing = [p for p in (result_dict.get("missing_components") or result_dict.get("missing_candidates") or []) if isinstance(p, str)]
        conflicting_parts = [p for p in (result_dict.get("conflicting_parts") or []) if isinstance(p, str)]

        clean_missing: List[str] = []
        observed_lower = [v.lower() for v in observed_components]
        for m in raw_missing:
            m_low = m.lower()
            is_vis = any(m_low in v or v in m_low for v in observed_lower)
            if not is_vis:
                tokens = [t for t in m_low.split() if len(t) >= 3 and t not in ("and", "the", "for", "with")]
                for v in observed_lower:
                    if any(t in v.split() for t in tokens):
                        is_vis = True
                        break
            if is_vis:
                if m not in conflicting_parts:
                    conflicting_parts.append(m)
            else:
                clean_missing.append(m)

        notes_str = str(result_dict.get("ambiguity") or result_dict.get("uncertainty_notes") or "")
        notes_lower = notes_str.lower()
        if "conflict" in notes_lower or ("photo" in notes_lower and "missing" in notes_lower) or ("label" in notes_lower and "missing" in notes_lower):
            # Dynamically reconcile any candidate parts mentioned in conflict notes without hardcoding
            for cand in list(clean_missing):
                if cand.lower() in notes_lower:
                    if cand not in conflicting_parts:
                        conflicting_parts.append(cand)
                    clean_missing.remove(cand)

        result_dict["observed_components"] = observed_components
        result_dict["visible_parts"] = observed_components
        result_dict["missing_components"] = clean_missing
        result_dict["missing_candidates"] = clean_missing
        result_dict["conflicting_parts"] = conflicting_parts

        # Align damage fields
        visible_damage = result_dict.get("visible_damage") or []
        damage_desc = result_dict.get("damage_description")
        if damage_desc and isinstance(damage_desc, str) and damage_desc.strip():
            if not visible_damage:
                visible_damage = [damage_desc]
        elif visible_damage and not damage_desc:
            damage_desc = "; ".join(str(d) for d in visible_damage)
        result_dict["visible_damage"] = visible_damage
        result_dict["damage_description"] = damage_desc

        # Align product identity fields
        prod_id = result_dict.get("product_identity") or result_dict.get("detected_product")
        observed_prod = result_dict.get("observed_product") or prod_id
        result_dict["product_identity"] = prod_id
        result_dict["detected_product"] = prod_id
        result_dict["observed_product"] = observed_prod

        # Image quality
        img_qual = result_dict.get("image_quality") or "good"
        result_dict["image_quality"] = img_qual

        result_dict["detected_evidence"] = {
            "product": prod_id,
            "product_identity": prod_id,
            "observed_product": observed_prod,
            "brand": result_dict.get("detected_brand"),
            "image_quality": img_qual,
            "is_product": is_product_bool,
            "expected_product_match": result_dict.get("expected_product_match"),
            "visible_parts": observed_components,
            "observed_components": observed_components,
            "missing_candidates": clean_missing,
            "missing_components": clean_missing,
            "conflicting_parts": conflicting_parts,
            "visible_damage": visible_damage,
            "damage_description": damage_desc,
            "condition": result_dict.get("condition"),
            "packaging_state": result_dict.get("packaging_state"),
            "uncertainty_notes": result_dict.get("uncertainty_notes"),
            "ambiguity": result_dict.get("ambiguity"),
            "recommended_reason_category": result_dict.get("recommended_reason_category"),
            "physical_product_detected": is_product_bool,
            "images_examined": len(images_data),
        }
        result_dict["inference_source"] = (
            f"gemini_multimodal:{self.active_model} (via {self.provider})"
            if is_gemini
            else f"multimodal:{self.active_model}"
        )
        result_dict["is_gemini_inference"] = is_gemini
        result_dict["is_fallback"] = False

        total_bytes = sum(len(b) for (b, _, _) in images_data)
        log_block = (
            f"\n============================================================\n"
            f"  [GENERIC MULTIMODAL VISION INFERENCE COMPLETED]\n"
            f"============================================================\n"
            f"  - model used       : {result_dict['model_used']}\n"
            f"  - images analyzed  : {result_dict['images_analyzed']} ({len(images_data)} image(s), {total_bytes} bytes)\n"
            f"  - latency          : {elapsed_ms} ms\n"
            f"  - vision confidence: {result_dict['vision_confidence']}\n"
            f"  - detected evidence: {json.dumps(result_dict['detected_evidence'], indent=4)}\n"
            f"  - source           : {result_dict['inference_source']}\n"
            f"============================================================"
        )
        logger.info(log_block)

        return VisionEvidence(**result_dict)

    def extract_evidence(
        self,
        image_base64: Optional[str] = None,
        image_filename: Optional[str] = None,
        image_filenames: Optional[List[str]] = None,
        catalog_product: Optional[Any] = None,
        context_hints: Optional[Dict[str, Any]] = None,
        verified_images: Optional[List[Tuple[bytes, str, str]]] = None,
    ) -> VisionEvidence:
        """Extracts observable evidence from return image(s) in a single batched multimodal call.

        When verified_images is provided, it receives a list of (image_bytes, mime_type, ref)
        tuples whose SHA-256 hashes and path containment boundaries were already validated.
        VisionAgent analyzes these exact bytes directly without re-reading from disk, ensuring
        complete evidence integrity between hashing and visual analysis.
        """
        target_filenames: List[str] = []
        images_data: List[Tuple[bytes, str, str]] = []
        cached_b64_str: Optional[str] = None

        if verified_images is not None:
            target_filenames = [fname for (_, _, fname) in verified_images]
            for data, mime, fname in verified_images:
                quality_issue = self._inspect_image_quality(data, fname)
                if quality_issue:
                    logger.info(f"VisionAgent: Image quality issue in {fname}: {quality_issue['reason']}")
                    return self._local_visual_extraction(
                        has_image=True,
                        image_filenames=target_filenames,
                        catalog_product=catalog_product,
                        image_quality_issue=quality_issue,
                    )
                images_data.append((data, mime, fname))

        elif image_filenames is not None or image_filename:
            if image_filenames is not None:
                target_filenames.extend([str(f) for f in image_filenames])
            elif image_filename:
                target_filenames.append(str(image_filename))

            for fname in target_filenames:
                file_path = Path(fname)
                if not file_path.exists() or not file_path.is_file():
                    return self._local_visual_extraction(
                        has_image=True,
                        image_filenames=target_filenames,
                        catalog_product=catalog_product,
                        image_quality_issue={
                            "reason": f"Image file not found or inaccessible ({file_path.name}); cannot verify return without examining all provided photos.",
                            "confidence": 0.20,
                        },
                    )
                try:
                    data = file_path.read_bytes()
                except Exception as exc:
                    return self._local_visual_extraction(
                        has_image=True,
                        image_filenames=target_filenames,
                        catalog_product=catalog_product,
                        image_quality_issue={
                            "reason": f"Failed to read image file ({file_path.name}): {exc}; manual inspection required.",
                            "confidence": 0.15,
                        },
                    )

                suffix = file_path.suffix.lower()
                if suffix == ".png":
                    mime = "image/png"
                elif suffix == ".webp":
                    mime = "image/webp"
                elif suffix == ".gif":
                    mime = "image/gif"
                elif suffix == ".bmp":
                    mime = "image/bmp"
                elif suffix == ".heic":
                    mime = "image/heic"
                else:
                    mime = "image/jpeg"

                quality_issue = self._inspect_image_quality(data, str(file_path))
                if quality_issue:
                    logger.info(f"VisionAgent: Image quality issue in {file_path.name}: {quality_issue['reason']}")
                    return self._local_visual_extraction(
                        has_image=True,
                        image_filenames=target_filenames,
                        catalog_product=catalog_product,
                        image_quality_issue=quality_issue,
                    )

                images_data.append((data, mime, str(file_path)))

        elif image_base64:
            try:
                raw_b64 = image_base64
                mime = "image/jpeg"
                if "base64," in raw_b64:
                    prefix, raw_b64 = raw_b64.split("base64,", 1)
                    if "image/png" in prefix:
                        mime = "image/png"
                    elif "image/webp" in prefix:
                        mime = "image/webp"
                    elif "image/gif" in prefix:
                        mime = "image/gif"
                clean_b64 = raw_b64.strip()
                data = base64.b64decode(clean_b64)
                cached_b64_str = clean_b64

                quality_issue = self._inspect_image_quality(data, "uploaded_image")
                if quality_issue:
                    return self._local_visual_extraction(
                        has_image=True,
                        image_filenames=["uploaded_image"],
                        catalog_product=catalog_product,
                        image_quality_issue=quality_issue,
                    )
                images_data.append((data, mime, "uploaded_image"))
            except Exception as exc:
                return self._local_visual_extraction(
                    has_image=True,
                    image_filenames=["uploaded_image"],
                    catalog_product=catalog_product,
                    image_quality_issue={
                        "reason": f"Corrupted or invalid base64 image data ({exc}); manual inspection required.",
                        "confidence": 0.15,
                    },
                )

        if not images_data:
            return self._local_visual_extraction(
                has_image=False,
                image_filenames=[],
                catalog_product=catalog_product,
                image_quality_issue=None,
            )

        if self.provider == "OpenRouter":
            for attempt in range(2):
                try:
                    return self._call_openrouter_vision(
                        images_data=images_data,
                        catalog_product=catalog_product,
                        cached_b64=cached_b64_str,
                    )
                except Exception as exc:
                    if attempt == 0 and ("getaddrinfo" in str(exc).lower() or "timed out" in str(exc).lower() or "connection reset" in str(exc).lower()):
                        logger.warning(f"Transient OpenRouter network issue ({exc}); retrying once...")
                        time.sleep(1.0)
                        continue
                    logger.warning(f"OpenRouter Vision call failed: {exc}. Diverting to strict uncertainty failure state.")
                    break

        elif self.provider == "Google GenAI" and self.client:
            for attempt in range(3):
                try:
                    return self._call_gemini_vision(
                        images_data=images_data,
                        catalog_product=catalog_product,
                    )
                except Exception as exc:
                    exc_str = str(exc).lower()
                    is_transient = any(
                        term in exc_str
                        for term in [
                            "ssl", "connection", "timed out", "timeout",
                            "nameresolution", "getaddrinfo", "11002", "eof",
                            "reset", "503",
                        ]
                    )
                    if attempt < 2 and is_transient:
                        logger.warning(
                            f"Transient Google GenAI network/DNS issue ({exc}); retrying attempt {attempt+2}/3 in 1.5s..."
                        )
                        time.sleep(1.5)
                        continue
                    logger.warning(
                        f"Gemini Vision call failed: {exc}. Diverting to strict uncertainty failure state."
                    )
                    break

        return self._local_visual_extraction(
            has_image=True,
            image_filenames=target_filenames,
            catalog_product=catalog_product,
            image_quality_issue=None,
        )

    def _call_openrouter_vision(
        self,
        images_data: Optional[List[Tuple[bytes, str, str]]] = None,
        image_bytes: Optional[bytes] = None,
        mime_type: str = "image/jpeg",
        catalog_product: Optional[Any] = None,
        image_filename: Optional[str] = None,
        cached_b64: Optional[str] = None,
    ) -> VisionEvidence:
        """Invokes OpenRouter Multimodal Vision API (Google Gemini) in a single call for all images."""
        if images_data is None:
            images_data = [(image_bytes, mime_type, image_filename or "uploaded_image")] if image_bytes else []

        prompt = _build_vision_prompt(catalog_product, num_images=len(images_data))
        content_parts: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]

        for idx, (img_bytes, img_mime, filename) in enumerate(images_data, 1):
            b64_payload = (cached_b64 if (len(images_data) == 1 and cached_b64) else base64.b64encode(img_bytes).decode("utf-8"))
            b64_url = f"data:{img_mime};base64,{b64_payload}"
            if len(images_data) > 1:
                content_parts.append({"type": "text", "text": f"Photo {idx} of {len(images_data)} ({Path(filename).name}):"})
            content_parts.append({"type": "image_url", "image_url": {"url": b64_url}})

        payload = {
            "model": self.active_model,
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "user",
                    "content": content_parts,
                }
            ],
            "temperature": 0.1,
        }

        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://cube.returns.manager",
                "X-Title": "Cube Returns Manager",
            },
        )

        t_start = time.time()
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        raw_content = data["choices"][0]["message"].get("content") or ""
        clean_text = raw_content.strip()
        start = clean_text.find("{")
        end = clean_text.rfind("}")
        if start != -1 and end != -1:
            clean_text = clean_text[start : end + 1]

        result_dict = json.loads(clean_text)
        elapsed_ms = int((time.time() - t_start) * 1000)

        return self._parse_vision_response_dict(
            result_dict=result_dict,
            images_data=images_data,
            elapsed_ms=elapsed_ms,
        )

    def _call_gemini_vision(
        self,
        images_data: Optional[List[Tuple[bytes, str, str]]] = None,
        image_bytes: Optional[bytes] = None,
        mime_type: str = "image/jpeg",
        catalog_product: Optional[Any] = None,
        image_filename: Optional[str] = None,
    ) -> VisionEvidence:
        """Invokes Gemini Multimodal Vision API in a single call with all images in contents."""
        from google.genai import types

        if images_data is None:
            images_data = [(image_bytes, mime_type, image_filename or "uploaded_image")] if image_bytes else []

        prompt = _build_vision_prompt(catalog_product, num_images=len(images_data))
        t_start = time.time()
        logger.info(f"VisionAgent: Calling Gemini Vision API ({self.active_model}) with {len(images_data)} image(s)...")

        contents: List[Any] = []
        for idx, (img_bytes, img_mime, filename) in enumerate(images_data, 1):
            if len(images_data) > 1:
                contents.append(f"Photo {idx} of {len(images_data)} ({Path(filename).name}):")
            contents.append(types.Part.from_bytes(data=img_bytes, mime_type=img_mime))
        contents.append(prompt)

        candidate_models = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"]
        if self.active_model and self.active_model not in candidate_models:
            candidate_models.insert(0, self.active_model)

        last_exc = None
        for model_name in candidate_models:
            try:
                response = self.client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.1,
                    ),
                )
                clean_text = response.text.strip()
                start = clean_text.find("{")
                end = clean_text.rfind("}")
                if start != -1 and end != -1:
                    clean_text = clean_text[start : end + 1]
                result_json = json.loads(clean_text)
                elapsed_ms = int((time.time() - t_start) * 1000)
                self.active_model = model_name
                return self._parse_vision_response_dict(
                    result_dict=result_json,
                    images_data=images_data,
                    elapsed_ms=elapsed_ms,
                )
            except Exception as exc:
                last_exc = exc
                exc_lower = str(exc).lower()
                is_recoverable = any(
                    term in exc_lower
                    for term in [
                        "429", "resource_exhausted", "quota", "rate limit",
                        "503", "high demand", "not_found", "temporarily", "unavailable"
                    ]
                )
                if is_recoverable:
                    logger.warning(f"VisionAgent: Model {model_name} unavailable or quota exceeded ({exc}); trying next candidate model...")
                    continue
                raise exc

        if last_exc:
            raise last_exc

    def _local_visual_extraction(
        self,
        has_image: bool,
        image_filename: Optional[str] = None,
        image_filenames: Optional[List[str]] = None,
        catalog_product: Optional[Any] = None,
        image_quality_issue: Optional[Dict[str, Any]] = None,
    ) -> VisionEvidence:
        """Development failure state.

        Strictly returns UNCERTAIN with low confidence.
        NEVER fabricates observations or populates fields from catalog or scenario.
        Fake/mock fallback remains strictly disabled.
        """
        filenames: List[str] = []
        if image_filenames is not None:
            filenames = [str(f) for f in image_filenames]
        elif image_filename:
            filenames = [str(image_filename)]

        image_analyzed_str = (
            ", ".join(Path(f).name for f in filenames)
            if filenames
            else (image_filename or "uploaded_image")
        )

        if not has_image:
            return VisionEvidence(
                has_image=False,
                image_quality="unusable",
                is_product=False,
                physical_product_detected=None,
                detected_product=None,
                detected_brand=None,
                visible_parts=[],
                missing_candidates=[],
                visible_damage=[],
                packaging_state=None,
                uncertainty_notes=(
                    image_quality_issue.get("reason")
                    if image_quality_issue
                    else "No return images provided or accessible; visual inspection cannot be performed."
                ),
                confidence=0.0,
                recommended_reason_category="unusable_image",
                inference_source="no_image_provided",
                model_used="offline_no_image",
                image_analyzed="none",
                images_analyzed=[],
                vision_confidence=0.0,
                detected_evidence={},
                is_gemini_inference=False,
                is_fallback=True,
            )

        if image_quality_issue:
            issue_reason = image_quality_issue.get("reason", "Image quality is insufficient to verify product.")
            is_blurry = "blur" in issue_reason.lower()
            quality_tag = "blurry" if is_blurry else "unusable"
            rec_cat = "blurry_image" if is_blurry else "unusable_image"
            return VisionEvidence(
                has_image=True,
                image_quality=quality_tag,
                is_product=True,
                physical_product_detected=True,
                detected_product=None,
                detected_brand=None,
                visible_parts=[],
                missing_candidates=[],
                visible_damage=[],
                condition="uncertain",
                packaging_state="uncertain",
                uncertainty_notes=issue_reason,
                ambiguity=issue_reason,
                confidence=image_quality_issue.get("confidence", 0.20),
                recommended_reason_category=rec_cat,
                inference_source="image_quality_guard",
                model_used="image_quality_guard",
                image_analyzed=image_analyzed_str,
                images_analyzed=filenames,
                vision_confidence=image_quality_issue.get("confidence", 0.20),
                detected_evidence={"quality_issue": issue_reason, "recommended_reason_category": rec_cat},
                is_gemini_inference=False,
                is_fallback=True,
            )

        return VisionEvidence(
            has_image=True,
            image_quality="uncertain",
            is_product=None,
            physical_product_detected=None,
            detected_product=None,
            detected_brand=None,
            visible_parts=[],
            missing_candidates=[],
            visible_damage=[],
            condition="uncertain",
            packaging_state="uncertain",
            uncertainty_notes="Vision model offline or unable to identify item from visual evidence without API key. Returning uncertainty; manual inspection required.",
            ambiguity="API unavailable or unparseable visual model response",
            confidence=0.30,
            recommended_reason_category="api_failure",
            inference_source="offline_failure_state:model_unavailable",
            model_used="offline_failure_state",
            image_analyzed=image_analyzed_str,
            images_analyzed=filenames,
            vision_confidence=0.30,
            detected_evidence={"note": "offline_uncertainty_state", "recommended_reason_category": "api_failure"},
            is_gemini_inference=False,
            is_fallback=True,
        )



_default_vision_agent: Optional[VisionAgent] = None


def get_default_vision_agent() -> VisionAgent:
    """Returns or lazily creates the default VisionAgent singleton."""
    global _default_vision_agent
    if _default_vision_agent is None:
        _default_vision_agent = VisionAgent()
    return _default_vision_agent


def get_setup_status() -> Dict[str, Any]:
    """Verification helper: returns setup status of Gemini Vision, provider, model, and masked API key."""
    return get_default_vision_agent().get_setup_status()


def check_env_loading() -> Dict[str, Any]:
    """Verification helper: inspects .env file loading and API key presence."""
    return get_default_vision_agent().check_env_loading()


__all__ = [
    "VisionAgent",
    "VisionEvidence",
    "get_setup_status",
    "check_env_loading",
    "get_default_vision_agent",
]

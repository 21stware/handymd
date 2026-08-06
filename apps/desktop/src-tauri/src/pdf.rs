//! Markdown → PDF export (line-oriented, matching handymd's one-block-per-line model).
//!
//! The layout is a print rendition of the editor rather than a separate design:
//! type scale, font stack, colours and inline chrome are taken from
//! `apps/desktop/styles.css` and `packages/handymd/src/style.css`, declared here
//! in CSS px and converted once through `PX`. When the editor's CSS moves, the
//! constants below are the places to follow it.
//!
//! Uses `krilla`, which subsets fonts to only the glyphs actually drawn —
//! critical because embedding full CJK faces produced ~96MB PDFs that failed to
//! save from the UI.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::{Arc, Mutex, OnceLock};

use krilla::color::rgb;
use krilla::geom::{PathBuilder, Point};
use krilla::metadata::Metadata;
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, LineCap, Stroke};
use krilla::text::{Font, Tag, TextDirection};
use krilla::Document;
use rustybuzz::{ttf_parser, UnicodeBuffer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PdfError {
    #[error("font: {0}")]
    Font(String),
    #[error("render: {0}")]
    Render(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------- page metrics

const PAGE_W: f32 = 595.0; // A4 pt
const PAGE_H: f32 = 842.0;
const MARGIN: f32 = 56.0;
const RIGHT_EDGE: f32 = PAGE_W - MARGIN;

/// CSS px → PDF pt (1px = 0.75pt at 96dpi). Everything below is written in the
/// same numbers as the stylesheet so the two stay comparable at a glance.
const PX: f32 = 0.75;

// ------------------------------------------------------------------ type scale

/// `--font-size` / `--line-height` from the desktop shell.
const BODY_PX: f32 = 16.5;
const LINE_RATIO: f32 = 1.72;

const BODY: f32 = BODY_PX * PX;
const BODY_LEAD: f32 = BODY_PX * LINE_RATIO * PX;

/// `.hm-h1`…`.hm-h6` em multipliers (desktop overrides h1–h3).
const HEADING_EM: [f32; 6] = [1.7, 1.32, 1.14, 1.05, 1.05, 1.05];
const HEADING_LINE: f32 = 1.32;
const HEADING_MT: f32 = 0.45; // `.hm-heading` margin-top, in heading em
const HEADING_MB: f32 = 0.15;
const HEADING_WEIGHT: u16 = 600;

/// `.hm-code` / `.hm-code-line`.
const CODE_EM: f32 = 0.88;
const CODE_LINE: f32 = 1.6;
const CODE_PAD_X: f32 = 14.0 * PX;
const CODE_PAD_Y: f32 = 6.0 * PX;
const CODE_RADIUS: f32 = 8.0 * PX;

/// `.hm-quote`: 3px bar + 12px padding.
const QUOTE_BAR: f32 = 3.0 * PX;
const QUOTE_PAD: f32 = 12.0 * PX;

/// `.hm-list-indent` steps by 1.35rem per nesting level (2 leading spaces).
const LIST_INDENT: f32 = 1.35 * 16.0 * PX;
/// Gap after a bullet / number / checkbox.
const MARKER_GAP: f32 = 8.0 * PX;
/// `input.hm-checkbox` is 15×15.
const CHECKBOX: f32 = 15.0 * PX;

const TAG_EM: f32 = 0.85;
/// `.hm-code-lang`: 11px, uppercase, dimmed.
const LANG_PX: f32 = 11.0;

// --------------------------------------------------------------------- colours

type Rgb = (u8, u8, u8);

const INK: Rgb = (0x2c, 0x2c, 0x2e); // --app-hm-fg
const DIM: Rgb = (0x9b, 0x9b, 0xa0); // --app-hm-fg-dim
const QUOTE_FG: Rgb = (0x6e, 0x6e, 0x73);
const ACCENT: Rgb = (0x35, 0x79, 0xdd);
const LINK_FG: Rgb = (0x2b, 0x62, 0xb4);
const LINK_RULE: Rgb = (0xaa, 0xc0, 0xe1); // link at 40% over paper
const CODE_FG: Rgb = (0x2b, 0x62, 0xb4);
const CODE_BG: Rgb = (0xf2, 0xf2, 0xf2); // rgba(0,0,0,.05) over paper
const PANEL_BG: Rgb = (0xf7, 0xf6, 0xf5);
const MARK_BG: Rgb = (0xd3, 0xe2, 0xf8); // accent at 22% over paper
const TAG_BG: Rgb = (0xeb, 0xf2, 0xfc); // accent at 10% over paper
const HR_FG: Rgb = (0xe6, 0xe6, 0xe6);
const CHECK_MARK: Rgb = (0xff, 0xff, 0xff);

// ----------------------------------------------------------------- style model

const REGULAR: u16 = 400;
const STRONG: u16 = 700;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct Style {
    weight: u16,
    italic: bool,
    mono: bool,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            weight: REGULAR,
            italic: false,
            mono: false,
        }
    }
}

/// Inline background treatment. The padding widens the run's advance exactly
/// like CSS inline padding does, so surrounding text shifts the same way.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Chip {
    None,
    Mark,
    Code,
    Tag,
}

impl Chip {
    fn pad(self) -> f32 {
        match self {
            Chip::None => 0.0,
            Chip::Mark => 2.0 * PX,
            Chip::Code => 4.0 * PX,
            Chip::Tag => 8.0 * PX,
        }
    }

    fn radius(self) -> f32 {
        match self {
            Chip::None => 0.0,
            Chip::Mark => 2.0 * PX,
            Chip::Code | Chip::Tag => 4.0 * PX,
        }
    }

    fn bg(self) -> Option<Rgb> {
        match self {
            Chip::None => None,
            Chip::Mark => Some(MARK_BG),
            Chip::Code => Some(CODE_BG),
            Chip::Tag => Some(TAG_BG),
        }
    }
}

#[derive(Clone, Debug)]
struct Run {
    text: String,
    size: f32,
    color: Rgb,
    style: Style,
    strike: bool,
    underline: bool,
    chip: Chip,
}

impl Run {
    fn plain(text: impl Into<String>, size: f32, color: Rgb) -> Self {
        Self {
            text: text.into(),
            size,
            color,
            style: Style::default(),
            strike: false,
            underline: false,
            chip: Chip::None,
        }
    }
}

// ------------------------------------------------------------------ font book

/// Reads a font file once per process. The leak is bounded by the number of
/// distinct faces on the system and avoids re-reading ~20MB CJK files on every
/// export.
fn font_bytes(path: &str) -> Option<&'static [u8]> {
    type Cache = Mutex<HashMap<String, Option<&'static [u8]>>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().ok()?;
    if let Some(hit) = guard.get(path) {
        return *hit;
    }
    let loaded = std::fs::read(path)
        .ok()
        .map(|bytes| &*Box::leak(bytes.into_boxed_slice()));
    guard.insert(path.to_string(), loaded);
    loaded
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct FaceKey {
    path: &'static str,
    weight: u16,
    italic: bool,
    /// Optical size in whole CSS px; SF Pro tightens its shapes at display sizes
    /// and the browser applies the same axis, so the PDF has to as well.
    opsz: u16,
}

struct Face {
    font: Font,
    rb: rustybuzz::Face<'static>,
    upem: f32,
    ascent: f32,
    descent: f32,
}

impl Face {
    fn covers(&self, c: char) -> bool {
        c.is_whitespace() || self.rb.glyph_index(c).is_some()
    }
}

/// Font stacks mirroring `--font` / `--mono` in the desktop shell, with CJK and
/// last-resort fallbacks appended the way a browser would.
fn stack(style: Style) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    if style.mono {
        out.push(if style.italic {
            "/System/Library/Fonts/SFNSMonoItalic.ttf"
        } else {
            "/System/Library/Fonts/SFNSMono.ttf"
        });
        out.push("/System/Library/Fonts/Menlo.ttc");
        out.push("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf");
    } else {
        out.push(if style.italic {
            "/System/Library/Fonts/SFNSItalic.ttf"
        } else {
            "/System/Library/Fonts/SFNS.ttf"
        });
        out.push("/System/Library/Fonts/HelveticaNeue.ttc");
        out.push("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
    }
    out.push("/System/Library/Fonts/PingFang.ttc");
    out.push("/System/Library/Fonts/Hiragino Sans GB.ttc");
    out.push("/System/Library/Fonts/STHeiti Medium.ttc");
    out.push("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc");
    out.push("/Library/Fonts/Arial Unicode.ttf");
    out.push("/System/Library/Fonts/Supplemental/Arial Unicode.ttf");
    out
}

/// In a collection, pick the face closest to the requested weight and slant,
/// skipping the dot-prefixed UI variants macOS ships alongside the real ones.
fn best_index(data: &[u8], weight: u16, italic: bool) -> u32 {
    let count = ttf_parser::fonts_in_collection(data).unwrap_or(1);
    let mut best = (u32::MAX, 0u32);
    for i in 0..count {
        let Ok(face) = ttf_parser::Face::parse(data, i) else {
            continue;
        };
        let internal = face
            .names()
            .into_iter()
            .filter(|n| n.name_id == ttf_parser::name_id::FULL_NAME)
            .find_map(|n| n.to_string())
            .map(|n| n.starts_with('.'))
            .unwrap_or(false);
        let dw = (face.weight().to_number() as i32 - weight as i32).unsigned_abs();
        let cost = dw + if face.is_italic() == italic { 0 } else { 400 } + u32::from(internal) * 2000;
        if cost < best.0 {
            best = (cost, i);
        }
    }
    best.1
}

/// The faces to try, in order, for one (style, optical size) combination.
type Chain = Rc<Vec<Rc<Face>>>;

struct FontBook {
    faces: RefCell<HashMap<FaceKey, Option<Rc<Face>>>>,
    chains: RefCell<HashMap<(Style, u16), Chain>>,
    widths: RefCell<HashMap<(Style, u16, String), f32>>,
    /// `HANDYMD_PDF_FONT` override, tried ahead of the system stack.
    extra: Option<&'static str>,
}

fn env_font() -> Option<&'static str> {
    static OVERRIDE: OnceLock<Option<&'static str>> = OnceLock::new();
    *OVERRIDE.get_or_init(|| {
        std::env::var("HANDYMD_PDF_FONT")
            .ok()
            .map(|s| &*Box::leak(s.into_boxed_str()))
    })
}

impl FontBook {
    fn new() -> Self {
        Self {
            faces: RefCell::new(HashMap::new()),
            chains: RefCell::new(HashMap::new()),
            widths: RefCell::new(HashMap::new()),
            extra: env_font(),
        }
    }

    fn face(&self, key: FaceKey) -> Option<Rc<Face>> {
        if let Some(hit) = self.faces.borrow().get(&key) {
            return hit.clone();
        }
        let built = self.build_face(key);
        self.faces.borrow_mut().insert(key, built.clone());
        built
    }

    fn build_face(&self, key: FaceKey) -> Option<Rc<Face>> {
        let data = font_bytes(key.path)?;
        let index = best_index(data, key.weight, key.italic);
        let parsed = ttf_parser::Face::parse(data, index).ok()?;

        // Pin whichever axes this face actually exposes; a static face keeps its
        // own design values.
        let mut coords: Vec<([u8; 4], f32)> = Vec::new();
        for axis in parsed.variation_axes() {
            let tag = axis.tag.to_bytes();
            let target = match &tag {
                b"wght" => key.weight as f32,
                b"opsz" => key.opsz as f32,
                _ => continue,
            };
            coords.push((tag, target.clamp(axis.min_value, axis.max_value)));
        }

        let krilla_coords: Vec<(Tag, f32)> = coords
            .iter()
            .map(|(tag, value)| (Tag::new(tag), *value))
            .collect();
        let shared: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(data);
        let font = Font::new_variable(shared.into(), index, &krilla_coords)?;

        // The measurer has to see the same instance krilla will draw.
        let mut rb = rustybuzz::Face::from_slice(data, index)?;
        for (tag, value) in &coords {
            rb.set_variation(ttf_parser::Tag::from_bytes(tag), *value);
        }

        let upem = parsed.units_per_em() as f32;
        let upem = if upem > 0.0 { upem } else { 1000.0 };
        Some(Rc::new(Face {
            font,
            rb,
            upem,
            ascent: parsed.ascender() as f32 / upem,
            descent: -(parsed.descender() as f32) / upem,
        }))
    }

    fn chain(&self, style: Style, size: f32) -> Chain {
        // SF Pro's optical axis starts at 17; below that the browser clamps too.
        let opsz = (size / PX).clamp(17.0, 96.0).round() as u16;
        if let Some(hit) = self.chains.borrow().get(&(style, opsz)) {
            return hit.clone();
        }
        let mut faces = Vec::new();
        for path in self.extra.iter().copied().chain(stack(style)) {
            if let Some(face) = self.face(FaceKey {
                path,
                weight: style.weight,
                italic: style.italic,
                opsz,
            }) {
                faces.push(face);
            }
        }
        let chain = Rc::new(faces);
        self.chains
            .borrow_mut()
            .insert((style, opsz), chain.clone());
        chain
    }

    /// Split text into the longest stretches a single face can render, the way
    /// a browser walks its font stack per character.
    fn split(&self, text: &str, style: Style, size: f32) -> Vec<(Rc<Face>, String)> {
        let chain = self.chain(style, size);
        let mut out: Vec<(Rc<Face>, String)> = Vec::new();
        if chain.is_empty() {
            return out;
        }
        for ch in text.chars() {
            let pick = chain
                .iter()
                .position(|f| f.covers(ch))
                .unwrap_or(chain.len() - 1);
            match out.last_mut() {
                Some((face, buf)) if Rc::ptr_eq(face, &chain[pick]) => buf.push(ch),
                _ => out.push((chain[pick].clone(), ch.to_string())),
            }
        }
        out
    }

    fn width(&self, text: &str, style: Style, size: f32) -> f32 {
        if text.is_empty() {
            return 0.0;
        }
        let key = (style, (size * 64.0) as u16, text.to_string());
        if let Some(hit) = self.widths.borrow().get(&key) {
            return *hit;
        }
        let mut total = 0.0;
        for (face, chunk) in self.split(text, style, size) {
            let mut buffer = UnicodeBuffer::new();
            buffer.push_str(&chunk);
            buffer.guess_segment_properties();
            let shaped = rustybuzz::shape(&face.rb, &[], buffer);
            let units: i32 = shaped.glyph_positions().iter().map(|p| p.x_advance).sum();
            total += units as f32 / face.upem * size;
        }
        self.widths.borrow_mut().insert(key, total);
        total
    }

    /// Ascent/descent of the primary face — the box CSS paints inline
    /// backgrounds into.
    fn metrics(&self, style: Style, size: f32) -> (f32, f32) {
        let chain = self.chain(style, size);
        match chain.first() {
            Some(face) => (face.ascent * size, face.descent * size),
            None => (size * 0.8, size * 0.2),
        }
    }

    fn run_width(&self, run: &Run) -> f32 {
        self.width(&run.text, run.style, run.size) + run.chip.pad() * 2.0
    }

    fn runs_width(&self, runs: &[Run]) -> f32 {
        runs.iter().map(|r| self.run_width(r)).sum()
    }
}

// ------------------------------------------------------------------ line model

/// Which block chrome a line sits inside — drives the quote bar and the code
/// panel, both of which span consecutive lines.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Block {
    Body,
    Quote,
    Code,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Marker {
    Bullet,
    Todo { checked: bool },
}

/// A logical (source) line, before wrapping.
enum Line {
    Spacer(f32),
    Rule,
    Text {
        /// The block's own font size, which fixes the baseline even when the
        /// line starts with a smaller inline run.
        size: f32,
        leading: f32,
        /// Bullet / checkbox drawn once on the first visual line so wrapped
        /// continuations hang under the text.
        marker: Option<Marker>,
        /// Ordered-list number, drawn like a marker but as text.
        number: Option<Run>,
        runs: Vec<Run>,
        block: Block,
        indent: f32,
    },
}

/// A visual line with x positions resolved — never wider than the margins.
enum Draw {
    Spacer(f32),
    Rule,
    Text {
        size: f32,
        leading: f32,
        x: f32,
        marker: Option<(f32, Marker)>,
        number: Option<(f32, Run)>,
        runs: Vec<Run>,
        block: Block,
    },
}

fn draw_height(line: &Draw) -> f32 {
    match line {
        Draw::Spacer(h) => *h,
        // `hr` sits inside a normal block, so it occupies one body line.
        Draw::Rule => BODY_LEAD,
        Draw::Text { leading, .. } => *leading,
    }
}

// --------------------------------------------------------------------- export

/// Export markdown to a PDF file at `path`.
///
/// `title` is PDF metadata only — not printed again (markdown usually has `# title`).
pub fn export_markdown_pdf(markdown: &str, title: &str, path: &Path) -> Result<(), PdfError> {
    let book = FontBook::new();
    if book.chain(Style::default(), BODY).is_empty() {
        return Err(PdfError::Font("no usable system font".into()));
    }
    let lines = build_draws(&book, layout_lines(markdown));

    let mut document = Document::new();
    document.set_metadata(Metadata::new().title(title.to_string()));

    // Paginate into chunks that fit one A4 page, then draw each chunk.
    let mut pages: Vec<Vec<&Draw>> = Vec::new();
    let mut current: Vec<&Draw> = Vec::new();
    let mut y = MARGIN;
    for line in &lines {
        let height = draw_height(line);
        if !current.is_empty() && y + height > PAGE_H - MARGIN {
            pages.push(std::mem::take(&mut current));
            y = MARGIN;
        }
        current.push(line);
        y += height;
    }
    if !current.is_empty() {
        pages.push(current);
    }
    if pages.is_empty() {
        pages.push(Vec::new());
    }

    for page_lines in pages {
        let mut page = document.start_page_with(
            PageSettings::from_wh(PAGE_W, PAGE_H)
                .ok_or_else(|| PdfError::Render("page size".into()))?,
        );
        let mut surface = page.surface();
        let mut y = MARGIN;
        let mut i = 0usize;

        while i < page_lines.len() {
            match page_lines[i] {
                Draw::Spacer(h) => {
                    y += h;
                    i += 1;
                }
                Draw::Rule => {
                    stroke_hline(&mut surface, MARGIN, RIGHT_EDGE, y + BODY_LEAD / 2.0, HR_FG, PX);
                    y += BODY_LEAD;
                    i += 1;
                }
                Draw::Text { block, .. } => {
                    // Quote bars and code panels span the whole run of lines
                    // they enclose, so consume the group in one go.
                    let group_block = *block;
                    let mut j = i;
                    let mut height = 0.0f32;
                    while j < page_lines.len() {
                        match page_lines[j] {
                            Draw::Text { block, leading, .. } if *block == group_block => {
                                height += leading;
                                j += 1;
                            }
                            _ => break,
                        }
                    }

                    match group_block {
                        Block::Quote => {
                            stroke_vline(
                                &mut surface,
                                MARGIN + QUOTE_BAR / 2.0,
                                y,
                                y + height,
                                ACCENT,
                                QUOTE_BAR,
                            );
                        }
                        Block::Code => {
                            fill_round_rect(
                                &mut surface,
                                MARGIN,
                                y,
                                RIGHT_EDGE,
                                y + height,
                                CODE_RADIUS,
                                PANEL_BG,
                            );
                        }
                        Block::Body => {}
                    }

                    for line in &page_lines[i..j] {
                        if let Draw::Text {
                            size,
                            leading,
                            x,
                            marker,
                            number,
                            runs,
                            ..
                        } = line
                        {
                            draw_text_line(
                                &mut surface,
                                &book,
                                marker,
                                number,
                                runs,
                                *x,
                                y,
                                *size,
                                *leading,
                            );
                            y += leading;
                        }
                    }
                    i = j;
                }
            }
        }

        surface.finish();
        page.finish();
    }

    let pdf = document
        .finish()
        .map_err(|e| PdfError::Render(format!("{e:?}")))?;
    std::fs::write(path, pdf)?;
    Ok(())
}

// -------------------------------------------------------------------- drawing

fn paint(color: Rgb) -> Fill {
    Fill {
        paint: rgb::Color::new(color.0, color.1, color.2).into(),
        opacity: NormalizedF32::ONE,
        rule: Default::default(),
    }
}

fn stroke_hline(
    surface: &mut krilla::surface::Surface<'_>,
    x0: f32,
    x1: f32,
    y: f32,
    color: Rgb,
    width: f32,
) {
    let mut pb = PathBuilder::new();
    pb.move_to(x0, y);
    pb.line_to(x1, y);
    if let Some(path) = pb.finish() {
        surface.set_fill(None);
        surface.set_stroke(Some(Stroke {
            paint: rgb::Color::new(color.0, color.1, color.2).into(),
            width,
            ..Default::default()
        }));
        surface.draw_path(&path);
        surface.set_stroke(None);
    }
}

fn stroke_vline(
    surface: &mut krilla::surface::Surface<'_>,
    x: f32,
    y0: f32,
    y1: f32,
    color: Rgb,
    width: f32,
) {
    let mut pb = PathBuilder::new();
    pb.move_to(x, y0);
    pb.line_to(x, y1);
    if let Some(path) = pb.finish() {
        surface.set_fill(None);
        surface.set_stroke(Some(Stroke {
            paint: rgb::Color::new(color.0, color.1, color.2).into(),
            width,
            line_cap: LineCap::Butt,
            ..Default::default()
        }));
        surface.draw_path(&path);
        surface.set_stroke(None);
    }
}

const KAPPA: f32 = 0.5523;

fn round_rect_path(x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> Option<krilla::geom::Path> {
    let r = r.min((x1 - x0) / 2.0).min((y1 - y0) / 2.0).max(0.0);
    let c = r * KAPPA;
    let mut pb = PathBuilder::new();
    pb.move_to(x0 + r, y0);
    pb.line_to(x1 - r, y0);
    pb.cubic_to(x1 - r + c, y0, x1, y0 + r - c, x1, y0 + r);
    pb.line_to(x1, y1 - r);
    pb.cubic_to(x1, y1 - r + c, x1 - r + c, y1, x1 - r, y1);
    pb.line_to(x0 + r, y1);
    pb.cubic_to(x0 + r - c, y1, x0, y1 - r + c, x0, y1 - r);
    pb.line_to(x0, y0 + r);
    pb.cubic_to(x0, y0 + r - c, x0 + r - c, y0, x0 + r, y0);
    pb.close();
    pb.finish()
}

fn fill_round_rect(
    surface: &mut krilla::surface::Surface<'_>,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    r: f32,
    color: Rgb,
) {
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    if let Some(path) = round_rect_path(x0, y0, x1, y1, r) {
        surface.set_stroke(None);
        surface.set_fill(Some(paint(color)));
        surface.draw_path(&path);
    }
}

fn circle_path(cx: f32, cy: f32, r: f32) -> Option<krilla::geom::Path> {
    let c = r * KAPPA;
    let mut pb = PathBuilder::new();
    pb.move_to(cx, cy - r);
    pb.cubic_to(cx + c, cy - r, cx + r, cy - c, cx + r, cy);
    pb.cubic_to(cx + r, cy + c, cx + c, cy + r, cx, cy + r);
    pb.cubic_to(cx - c, cy + r, cx - r, cy + c, cx - r, cy);
    pb.cubic_to(cx - r, cy - c, cx - c, cy - r, cx, cy - r);
    pb.close();
    pb.finish()
}

fn fill_circle(surface: &mut krilla::surface::Surface<'_>, cx: f32, cy: f32, r: f32, color: Rgb) {
    if let Some(path) = circle_path(cx, cy, r) {
        surface.set_stroke(None);
        surface.set_fill(Some(paint(color)));
        surface.draw_path(&path);
    }
}

fn stroke_circle(
    surface: &mut krilla::surface::Surface<'_>,
    cx: f32,
    cy: f32,
    r: f32,
    color: Rgb,
    width: f32,
) {
    if let Some(path) = circle_path(cx, cy, r) {
        surface.set_fill(None);
        surface.set_stroke(Some(Stroke {
            paint: rgb::Color::new(color.0, color.1, color.2).into(),
            width,
            ..Default::default()
        }));
        surface.draw_path(&path);
        surface.set_stroke(None);
    }
}

/// The editor's round checkbox, drawn as vectors rather than a ☐/☑ glyph so it
/// looks the same in print as on screen.
fn draw_checkbox(surface: &mut krilla::surface::Surface<'_>, x: f32, mid: f32, checked: bool) {
    let r = CHECKBOX / 2.0;
    let cx = x + r;
    if checked {
        fill_circle(surface, cx, mid, r, ACCENT);
        let mut pb = PathBuilder::new();
        pb.move_to(cx - r * 0.38, mid);
        pb.line_to(cx - r * 0.10, mid + r * 0.30);
        pb.line_to(cx + r * 0.42, mid - r * 0.32);
        if let Some(path) = pb.finish() {
            surface.set_fill(None);
            surface.set_stroke(Some(Stroke {
                paint: rgb::Color::new(CHECK_MARK.0, CHECK_MARK.1, CHECK_MARK.2).into(),
                width: 1.5 * PX,
                line_cap: LineCap::Round,
                ..Default::default()
            }));
            surface.draw_path(&path);
            surface.set_stroke(None);
        }
    } else {
        stroke_circle(surface, cx, mid, r - 0.75 * PX, (0xc3, 0xc3, 0xc8), 1.5 * PX);
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_text_line(
    surface: &mut krilla::surface::Surface<'_>,
    book: &FontBook,
    marker: &Option<(f32, Marker)>,
    number: &Option<(f32, Run)>,
    runs: &[Run],
    x: f32,
    top: f32,
    size: f32,
    leading: f32,
) {
    let (asc, desc) = book.metrics(Style::default(), size);
    // CSS centres the font's content box inside the line box; half-leading above
    // and below puts the baseline here.
    let baseline = top + (leading - (asc + desc)) / 2.0 + asc;

    if let Some((mx, marker)) = marker {
        // Both markers are optically centred on the x-height band, the way the
        // editor's inline widgets sit.
        let mid = baseline - (asc - desc) / 2.0;
        match marker {
            Marker::Bullet => fill_circle(surface, mx + size * 0.16, mid, size * 0.155, ACCENT),
            Marker::Todo { checked } => draw_checkbox(surface, *mx, mid, *checked),
        }
    }
    if let Some((nx, run)) = number {
        draw_runs(surface, book, std::slice::from_ref(run), *nx, baseline);
    }
    draw_runs(surface, book, runs, x, baseline);
}

fn draw_runs(
    surface: &mut krilla::surface::Surface<'_>,
    book: &FontBook,
    runs: &[Run],
    start_x: f32,
    baseline: f32,
) {
    // Backgrounds first so neighbouring chips can't paint over each other's text.
    let mut x = start_x;
    for run in runs {
        let advance = book.run_width(run);
        if let Some(bg) = run.chip.bg() {
            let (asc, desc) = book.metrics(run.style, run.size);
            fill_round_rect(
                surface,
                x,
                baseline - asc,
                x + advance,
                baseline + desc,
                run.chip.radius(),
                bg,
            );
        }
        x += advance;
    }

    x = start_x;
    for run in runs {
        let advance = book.run_width(run);
        let pad = run.chip.pad();
        if !run.text.is_empty() {
            surface.set_stroke(None);
            surface.set_fill(Some(paint(run.color)));
            let mut gx = x + pad;
            for (face, chunk) in book.split(&run.text, run.style, run.size) {
                surface.draw_text(
                    Point::from_xy(gx, baseline),
                    face.font.clone(),
                    run.size,
                    &chunk,
                    false,
                    TextDirection::Auto,
                );
                gx += book.width(&chunk, run.style, run.size);
            }
        }
        let text_w = advance - pad * 2.0;
        if run.strike {
            stroke_hline(
                surface,
                x + pad,
                x + pad + text_w,
                baseline - run.size * 0.28,
                run.color,
                run.size * 0.055,
            );
        }
        if run.underline {
            stroke_hline(
                surface,
                x + pad,
                x + pad + text_w,
                baseline + run.size * 0.11,
                LINK_RULE,
                run.size * 0.06,
            );
        }
        x += advance;
    }
}

// -------------------------------------------------------------------- wrapping

/// One unbreakable chunk: a western word (with its trailing spaces), a single
/// CJK character, or a whole chip run.
struct Seg {
    frags: Vec<(usize, String)>,
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF
        | 0x2E80..=0x303F
        | 0x3040..=0x30FF
        | 0x3130..=0x318F
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xAC00..=0xD7AF
        | 0xF900..=0xFAFF
        | 0xFF00..=0xFF60
        | 0x20000..=0x2FA1F
    )
}

/// Punctuation that may not start a line (CJK line-breaking rules).
fn no_break_before(c: char) -> bool {
    matches!(
        c,
        '，' | '。'
            | '、'
            | '；'
            | '：'
            | '？'
            | '！'
            | '）'
            | '】'
            | '》'
            | '」'
            | '』'
            | '〉'
            | '〕'
            | '”'
            | '’'
            | '…'
            | '·'
            | '～'
            | ')'
            | ']'
            | '}'
            | ','
            | '.'
            | ';'
            | ':'
            | '?'
            | '!'
            | '%'
    )
}

/// Punctuation that may not end a line.
fn no_break_after(c: char) -> bool {
    matches!(
        c,
        '（' | '【' | '《' | '「' | '『' | '〈' | '〔' | '“' | '‘' | '(' | '[' | '{'
    )
}

fn can_break_before(prev: char, cur: char) -> bool {
    if cur.is_whitespace() {
        return false; // trailing spaces ride along with the word they follow
    }
    if no_break_before(cur) || no_break_after(prev) {
        return false;
    }
    if prev.is_whitespace() {
        return true;
    }
    is_cjk(prev) || is_cjk(cur)
}

fn segment_runs(runs: &[Run]) -> Vec<Seg> {
    let mut segs: Vec<Seg> = Vec::new();
    let mut prev: Option<(char, Chip)> = None;

    for (idx, run) in runs.iter().enumerate() {
        for ch in run.text.chars() {
            let start_new = match prev {
                None => true,
                // A chip's padding is drawn once around the whole run, so never
                // break inside it or merge it with its neighbours.
                Some((_, chip)) if chip != run.chip => true,
                Some(_) if run.chip != Chip::None => false,
                Some((p, _)) => can_break_before(p, ch),
            };
            if start_new || segs.is_empty() {
                segs.push(Seg { frags: Vec::new() });
            }
            let seg = segs.last_mut().expect("just pushed");
            match seg.frags.last_mut() {
                Some((i, s)) if *i == idx => s.push(ch),
                _ => seg.frags.push((idx, ch.to_string())),
            }
            prev = Some((ch, run.chip));
        }
    }
    segs
}

fn seg_width(book: &FontBook, seg: &Seg, src: &[Run]) -> f32 {
    seg.frags
        .iter()
        .map(|(idx, text)| {
            let run = &src[*idx];
            book.width(text, run.style, run.size) + run.chip.pad() * 2.0
        })
        .sum()
}

/// Rebuild styled runs for one visual line, dropping the trailing whitespace
/// that would otherwise stretch strike-throughs past the text.
fn segs_to_runs(segs: &[Seg], src: &[Run]) -> Vec<Run> {
    let mut parts: Vec<(usize, String)> = Vec::new();
    for seg in segs {
        for (idx, text) in &seg.frags {
            match parts.last_mut() {
                Some((i, s)) if i == idx => s.push_str(text),
                _ => parts.push((*idx, text.clone())),
            }
        }
    }
    while let Some((_, s)) = parts.last_mut() {
        let trimmed = s.trim_end().to_string();
        *s = trimmed;
        if s.is_empty() {
            parts.pop();
        } else {
            break;
        }
    }
    parts
        .into_iter()
        .map(|(idx, text)| Run {
            text,
            ..src[idx].clone()
        })
        .collect()
}

/// Break a chunk that cannot fit on any line (long URL, unspaced string).
fn hard_split(book: &FontBook, seg: &Seg, src: &[Run], avail: f32) -> Vec<Seg> {
    let mut out: Vec<Seg> = Vec::new();
    let mut cur = Seg { frags: Vec::new() };
    let mut w = 0.0f32;

    for (idx, text) in &seg.frags {
        let run = &src[*idx];
        for ch in text.chars() {
            let cw = book.width(&ch.to_string(), run.style, run.size);
            if !cur.frags.is_empty() && w + cw > avail {
                out.push(std::mem::replace(&mut cur, Seg { frags: Vec::new() }));
                w = 0.0;
            }
            match cur.frags.last_mut() {
                Some((i, s)) if i == idx => s.push(ch),
                _ => cur.frags.push((*idx, ch.to_string())),
            }
            w += cw;
        }
    }
    if !cur.frags.is_empty() {
        out.push(cur);
    }
    out
}

fn wrap_runs(book: &FontBook, runs: &[Run], avail: f32) -> Vec<Vec<Run>> {
    if runs.iter().all(|r| r.text.is_empty()) {
        return vec![runs.to_vec()];
    }
    if avail <= 0.0 || book.runs_width(runs) <= avail {
        return vec![runs.to_vec()];
    }

    let mut lines: Vec<Vec<Run>> = Vec::new();
    let mut cur: Vec<Seg> = Vec::new();
    let mut x = 0.0f32;

    let push_line = |cur: &mut Vec<Seg>, lines: &mut Vec<Vec<Run>>| {
        if !cur.is_empty() {
            lines.push(segs_to_runs(cur, runs));
            cur.clear();
        }
    };

    for seg in segment_runs(runs) {
        let w = seg_width(book, &seg, runs);
        let blank = seg
            .frags
            .iter()
            .all(|(_, s)| s.chars().all(char::is_whitespace));
        if !cur.is_empty() && x + w > avail {
            push_line(&mut cur, &mut lines);
            x = 0.0;
            if blank {
                continue; // never start a line with the space we broke at
            }
        }
        if w > avail {
            for piece in hard_split(book, &seg, runs, avail) {
                let pw = seg_width(book, &piece, runs);
                if !cur.is_empty() && x + pw > avail {
                    push_line(&mut cur, &mut lines);
                    x = 0.0;
                }
                cur.push(piece);
                x += pw;
            }
            continue;
        }
        cur.push(seg);
        x += w;
    }
    push_line(&mut cur, &mut lines);

    if lines.is_empty() {
        lines.push(runs.to_vec());
    }
    lines
}

/// Resolve logical lines into visual ones that always stay inside the margins.
fn build_draws(book: &FontBook, lines: Vec<Line>) -> Vec<Draw> {
    let mut out: Vec<Draw> = Vec::new();
    for line in lines {
        match line {
            Line::Spacer(h) => out.push(Draw::Spacer(h)),
            Line::Rule => out.push(Draw::Rule),
            Line::Text {
                size,
                leading,
                marker,
                number,
                runs,
                block,
                indent,
            } => {
                let gutter = match block {
                    Block::Quote => QUOTE_BAR + QUOTE_PAD,
                    Block::Code => CODE_PAD_X,
                    Block::Body => 0.0,
                };
                let left = MARGIN + indent + gutter;
                let marker_w = match (&marker, &number) {
                    (Some(Marker::Bullet), _) => book.width("•", Style::default(), size) + MARKER_GAP,
                    (Some(Marker::Todo { .. }), _) => CHECKBOX + MARKER_GAP,
                    // The source is `1. `, so the gap is just that space.
                    (None, Some(run)) => book.run_width(run) + book.width(" ", run.style, run.size),
                    _ => 0.0,
                };
                let body_x = left + marker_w;
                let avail = RIGHT_EDGE - body_x - gutter;

                for (i, visual) in wrap_runs(book, &runs, avail).into_iter().enumerate() {
                    let first = i == 0;
                    out.push(Draw::Text {
                        size,
                        leading,
                        x: body_x,
                        marker: if first { marker.map(|m| (left, m)) } else { None },
                        number: if first {
                            number.clone().map(|r| (left, r))
                        } else {
                            None
                        },
                        runs: visual,
                        block,
                    });
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------- block layout

fn layout_lines(markdown: &str) -> Vec<Line> {
    let mut out = Vec::new();
    let mut in_fence = false;
    let code_size = BODY * CODE_EM;
    let code_lead = code_size * CODE_LINE;
    let code_style = Style {
        mono: true,
        ..Style::default()
    };

    for line in markdown.lines() {
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            let lang = line.trim_start_matches(['`', '~']).trim();
            out.push(Line::Text {
                size: code_size,
                leading: code_lead + CODE_PAD_Y,
                marker: None,
                number: None,
                runs: if lang.is_empty() {
                    Vec::new()
                } else {
                    vec![Run::plain(lang.to_uppercase(), LANG_PX * PX, DIM)]
                },
                block: Block::Code,
                indent: 0.0,
            });
            continue;
        }
        if in_fence {
            out.push(Line::Text {
                size: code_size,
                leading: code_lead,
                marker: None,
                number: None,
                runs: vec![Run {
                    style: code_style,
                    ..Run::plain(line, code_size, INK)
                }],
                block: Block::Code,
                indent: 0.0,
            });
            continue;
        }

        if line.trim().is_empty() {
            out.push(Line::Spacer(BODY_LEAD));
            continue;
        }

        if is_hr(line) {
            out.push(Line::Rule);
            continue;
        }

        if let Some((level, content)) = parse_heading(line) {
            let size = BODY * HEADING_EM[(level as usize - 1).min(5)];
            out.push(Line::Spacer(size * HEADING_MT));
            out.push(Line::Text {
                size,
                leading: size * HEADING_LINE,
                marker: None,
                number: None,
                runs: inline_runs(content, INK, size, HEADING_WEIGHT),
                block: Block::Body,
                indent: 0.0,
            });
            out.push(Line::Spacer(size * HEADING_MB));
            continue;
        }

        if let Some(content) = line.strip_prefix("> ").or_else(|| (line == ">").then_some("")) {
            out.push(Line::Text {
                size: BODY,
                leading: BODY_LEAD,
                marker: None,
                number: None,
                runs: inline_runs(content, QUOTE_FG, BODY, REGULAR),
                block: Block::Quote,
                indent: 0.0,
            });
            continue;
        }

        if let Some((spaces, checked, content)) = parse_todo(line) {
            let mut runs = inline_runs(content, INK, BODY, REGULAR);
            if checked {
                for run in &mut runs {
                    run.color = DIM;
                    run.strike = true;
                }
            }
            out.push(Line::Text {
                size: BODY,
                leading: BODY_LEAD,
                marker: Some(Marker::Todo { checked }),
                number: None,
                runs,
                block: Block::Body,
                indent: list_indent(spaces),
            });
            continue;
        }

        if let Some((spaces, content)) = parse_bullet(line) {
            out.push(Line::Text {
                size: BODY,
                leading: BODY_LEAD,
                marker: Some(Marker::Bullet),
                number: None,
                runs: inline_runs(content, INK, BODY, REGULAR),
                block: Block::Body,
                indent: list_indent(spaces),
            });
            continue;
        }

        if let Some((spaces, num, content)) = parse_ordered(line) {
            out.push(Line::Text {
                size: BODY,
                leading: BODY_LEAD,
                marker: None,
                number: Some(Run::plain(format!("{num}."), BODY, ACCENT)),
                runs: inline_runs(content, INK, BODY, REGULAR),
                block: Block::Body,
                indent: list_indent(spaces),
            });
            continue;
        }

        out.push(Line::Text {
            size: BODY,
            leading: BODY_LEAD,
            marker: None,
            number: None,
            runs: inline_runs(line, INK, BODY, REGULAR),
            block: Block::Body,
            indent: 0.0,
        });
    }

    out
}

fn is_hr(line: &str) -> bool {
    let t = line.trim();
    if t.len() < 3 {
        return false;
    }
    let c = t.chars().next().unwrap();
    matches!(c, '-' | '*' | '_') && t.chars().all(|x| x == c)
}

fn parse_heading(line: &str) -> Option<(u8, &str)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    let content = rest.strip_prefix(' ')?;
    Some((hashes as u8, content))
}

fn leading_spaces(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ').count()
}

fn list_indent(spaces: usize) -> f32 {
    (spaces as f32 / 2.0) * LIST_INDENT
}

fn parse_todo(line: &str) -> Option<(usize, bool, &str)> {
    let spaces = leading_spaces(line);
    let t = &line[spaces..];
    for (prefix, checked) in [
        ("- [ ] ", false),
        ("* [ ] ", false),
        ("+ [ ] ", false),
        ("- [x] ", true),
        ("- [X] ", true),
        ("* [x] ", true),
        ("* [X] ", true),
        ("+ [x] ", true),
        ("+ [X] ", true),
    ] {
        if let Some(content) = t.strip_prefix(prefix) {
            return Some((spaces, checked, content));
        }
    }
    None
}

fn parse_bullet(line: &str) -> Option<(usize, &str)> {
    let spaces = leading_spaces(line);
    let t = &line[spaces..];
    if t.starts_with("- [") || t.starts_with("* [") || t.starts_with("+ [") {
        return None;
    }
    let content = t
        .strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| t.strip_prefix("+ "))?;
    Some((spaces, content))
}

fn parse_ordered(line: &str) -> Option<(usize, u32, &str)> {
    let spaces = leading_spaces(line);
    let t = &line[spaces..];
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let rest = &t[digits..];
    let content = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?;
    let num: u32 = t[..digits].parse().ok()?;
    Some((spaces, num, content))
}

// --------------------------------------------------------------- inline markup

/// Per-character flags, filled in by the same precedence the SDK's inline
/// scanner uses: code > image > link > strong > strike > mark > em > tag.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Mask {
    hidden: bool,
    strong: bool,
    em: bool,
    strike: bool,
    mark: bool,
    code: bool,
    link: bool,
    image: bool,
    tag: bool,
}

fn apply(mask: &mut [Mask], range: std::ops::Range<usize>, f: impl Fn(&mut Mask)) {
    mask[range].iter_mut().for_each(f);
}

fn inline_runs(text: &str, base: Rgb, size: f32, weight: u16) -> Vec<Run> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut taken = vec![false; n];
    let mut mask = vec![Mask::default(); n];

    let claim = |taken: &mut Vec<bool>, from: usize, to: usize| -> bool {
        if taken[from..to].iter().any(|t| *t) {
            return false;
        }
        taken[from..to].iter_mut().for_each(|t| *t = true);
        true
    };

    // 1. code spans — nothing inside them is parsed further
    let mut i = 0;
    while i < n {
        if chars[i] != '`' || (i > 0 && chars[i - 1] == '`') {
            i += 1;
            continue;
        }
        let ticks = chars[i..].iter().take_while(|c| **c == '`').count();
        let body = i + ticks;
        let mut j = body;
        let close = loop {
            if j >= n {
                break None;
            }
            if chars[j] == '`' {
                let run = chars[j..].iter().take_while(|c| **c == '`').count();
                if run == ticks {
                    break Some(j);
                }
                j += run;
                continue;
            }
            j += 1;
        };
        match close {
            Some(end) if end > body && claim(&mut taken, i, end + ticks) => {
                apply(&mut mask, i..body, |m| m.hidden = true);
                apply(&mut mask, body..end, |m| m.code = true);
                apply(&mut mask, end..end + ticks, |m| m.hidden = true);
                i = end + ticks;
            }
            _ => i += ticks.max(1),
        }
    }

    // 2. images, then 3. links — both hide their syntax and keep alt/label text
    for image in [true, false] {
        let mut i = 0;
        while i < n {
            let open = if image {
                i + 1 < n && chars[i] == '!' && chars[i + 1] == '['
            } else {
                chars[i] == '[' && (i == 0 || chars[i - 1] != '!')
            };
            if !open {
                i += 1;
                continue;
            }
            let label = i + usize::from(image) + 1;
            let Some(close) = (label..n).find(|k| chars[*k] == ']') else {
                i += 1;
                continue;
            };
            if chars[label..close].contains(&'[') || close + 1 >= n || chars[close + 1] != '(' {
                i += 1;
                continue;
            }
            let Some(paren) = (close + 2..n).find(|k| chars[*k] == ')') else {
                i += 1;
                continue;
            };
            if !claim(&mut taken, i, paren + 1) {
                i += 1;
                continue;
            }
            apply(&mut mask, i..paren + 1, |m| m.hidden = true);
            apply(&mut mask, label..close, |m| {
                m.hidden = false;
                if image {
                    m.image = true;
                } else {
                    m.link = true;
                }
            });
            i = paren + 1;
        }
    }

    // 4-6. strong / strike / mark — only the delimiters are claimed, so nesting
    // still resolves.
    for (delims, width, field) in [
        (&['*', '_'][..], 2usize, 0u8),
        (&['~'][..], 2, 1),
        (&['='][..], 2, 2),
    ] {
        let mut i = 0;
        while i + width * 2 < n + 1 {
            let c = chars[i];
            if !delims.contains(&c) || chars.get(i + 1) != Some(&c) {
                i += 1;
                continue;
            }
            if chars.get(i + width).map_or(true, |x| x.is_whitespace()) {
                i += 1;
                continue;
            }
            let mut j = i + width;
            let end = loop {
                if j + width > n {
                    break None;
                }
                if chars[j] == c && chars[j + 1] == c && !chars[j - 1].is_whitespace() && j > i + width
                {
                    break Some(j);
                }
                j += 1;
            };
            let Some(end) = end else {
                i += 1;
                continue;
            };
            if !claim(&mut taken, i, i + width) {
                i += 1;
                continue;
            }
            if !claim(&mut taken, end, end + width) {
                i += 1;
                continue;
            }
            apply(&mut mask, i..i + width, |m| m.hidden = true);
            apply(&mut mask, end..end + width, |m| m.hidden = true);
            apply(&mut mask, i + width..end, |m| match field {
                0 => m.strong = true,
                1 => m.strike = true,
                _ => m.mark = true,
            });
            i = end + width;
        }
    }

    // 7. em — single `*` / `_` pairs
    for delim in ['*', '_'] {
        let mut i = 0;
        while i < n {
            if chars[i] != delim || taken[i] || chars.get(i + 1).map_or(true, |c| c.is_whitespace())
            {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            let end = loop {
                if j >= n {
                    break None;
                }
                if chars[j] == delim && !taken[j] && !chars[j - 1].is_whitespace() && j > i + 1 {
                    break Some(j);
                }
                j += 1;
            };
            let Some(end) = end else {
                i += 1;
                continue;
            };
            if !claim(&mut taken, i, i + 1) || !claim(&mut taken, end, end + 1) {
                i += 1;
                continue;
            }
            mask[i].hidden = true;
            mask[end].hidden = true;
            apply(&mut mask, i + 1..end, |m| m.em = true);
            i = end + 1;
        }
    }

    // 8. tags — Bear-style `#tag` pills, always rendered
    let mut i = 0;
    while i < n {
        if chars[i] != '#' {
            i += 1;
            continue;
        }
        let boundary = i == 0
            || chars[i - 1].is_whitespace()
            || "(（【\"'：:，,、。;；".contains(chars[i - 1]);
        let head_ok = chars
            .get(i + 1)
            .is_some_and(|c| c.is_alphanumeric() || *c == '_');
        if !boundary || !head_ok {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end < n && (chars[end].is_alphanumeric() || "_-/".contains(chars[end])) {
            end += 1;
        }
        if claim(&mut taken, i, end) {
            apply(&mut mask, i..end, |m| m.tag = true);
        }
        i = end;
    }

    // Group equal masks into runs.
    let mut out: Vec<Run> = Vec::new();
    let mut start = 0usize;
    while start < n {
        if mask[start].hidden {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < n && !mask[end].hidden && mask[end] == mask[start] {
            end += 1;
        }
        let text: String = chars[start..end].iter().collect();
        out.push(styled_run(text, mask[start], base, size, weight));
        start = end;
    }
    if out.is_empty() {
        out.push(Run::plain(String::new(), size, base));
    }
    out
}

fn styled_run(text: String, m: Mask, base: Rgb, size: f32, weight: u16) -> Run {
    let mut run = Run::plain(text, size, base);
    run.style.weight = if m.strong { STRONG } else { weight };
    run.style.italic = m.em;

    if m.code {
        run.style.mono = true;
        run.size = size * CODE_EM;
        run.color = CODE_FG;
        run.chip = Chip::Code;
    } else if m.tag {
        run.size = size * TAG_EM;
        run.color = ACCENT;
        run.chip = Chip::Tag;
    } else if m.image {
        run.color = ACCENT;
    } else if m.link {
        run.color = LINK_FG;
        run.underline = true;
    } else if m.strike {
        run.color = DIM;
    }
    if m.mark && run.chip == Chip::None {
        run.chip = Chip::Mark;
    }
    run.strike = m.strike;
    run
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn book() -> Option<FontBook> {
        let book = FontBook::new();
        (!book.chain(Style::default(), BODY).is_empty()).then_some(book)
    }

    const SAMPLE: &str = "\
# 一个足够长的标题 that also mixes English so it has to wrap somewhere sensible

这是一段很长的中文段落，用来验证换行逻辑在中日韩文本下也能正常工作，不会让文字跑到页面的出血线之外去，标点符号也不应该出现在行首，比如「，。！？」这些。

The quick brown fox **jumps** over the *lazy* dog again and again until this paragraph is definitely wider than the printable area of an A4 page.

## 列表 #handymd

- 一个相当长的项目符号条目，需要折行，并且折行之后应该与文字左对齐，而不是回到项目符号的下面去
  - 更深一层的嵌套条目同样很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长
    - 第三层，also long enough that it wraps at least once
1. Ordered items wrap too, and the continuation hangs under the text rather than the number
2. 第二项

- [ ] A todo entry that is also quite long and therefore needs to be wrapped somewhere
- [x] ==完成的== 一项

### 引用

> A quoted line that runs well past the right edge of the page and must wrap inside the quote gutter.
> 引用里的中文同样需要折行，并且左侧的竖线应该是一整条而不是断开的线段。

---

`inline code`、~~删除线~~、[一个链接](https://example.com/docs)、![封面](img://cover)，以及
https://example.com/a/very/long/url/without/any/spaces/that/cannot/be/broken/at/word/boundaries

```ts
const wrapped = 'code lines also wrap instead of running off the page'
```
";

    /// Writes a torture sample for eyeballing:
    /// `cargo test --lib pdf::tests::write_visual_sample -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn write_visual_sample() {
        let path = std::path::PathBuf::from("/tmp/handymd-visual.pdf");
        // Same source next to the PDF, so the editor can be screenshotted from
        // it and the two compared.
        std::fs::write("/tmp/handymd-visual.md", SAMPLE).expect("write md");
        export_markdown_pdf(SAMPLE, "visual", &path).expect("export");
        println!("wrote {}", path.display());
    }

    #[test]
    fn export_is_small_and_works() {
        let path = temp_dir().join("handymd-krilla.pdf");
        export_markdown_pdf(SAMPLE, "This is the note", &path).expect("export");
        let len = path.metadata().unwrap().len();
        println!("pdf bytes={len}");
        // Subsetting should keep this well under a few MB (was ~96MB before).
        assert!(len > 1_000);
        assert!(len < 2_000_000, "pdf too large: {len}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn nothing_is_drawn_past_the_right_margin() {
        let Some(book) = book() else {
            eprintln!("no system font available; skipping");
            return;
        };
        for line in build_draws(&book, layout_lines(SAMPLE)) {
            let Draw::Text { x, runs, .. } = line else {
                continue;
            };
            let right = x + book.runs_width(&runs);
            let text: String = runs.iter().map(|r| r.text.as_str()).collect();
            assert!(
                right <= RIGHT_EDGE + 0.5,
                "overflows right margin by {:.1}pt: {text:?}",
                right - RIGHT_EDGE
            );
        }
    }

    #[test]
    fn wrapping_keeps_every_character() {
        let Some(book) = book() else { return };
        let runs = inline_runs(
            "alpha bravo ==charlie== delta echo foxtrot golf hotel india juliett kilo lima",
            INK,
            BODY,
            REGULAR,
        );
        let wrapped = wrap_runs(&book, &runs, 90.0);
        assert!(wrapped.len() > 1, "expected the line to wrap");

        let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let before = squash(&runs.iter().map(|r| r.text.as_str()).collect::<String>());
        let after = squash(
            &wrapped
                .iter()
                .map(|l| l.iter().map(|r| r.text.as_str()).collect::<String>())
                .collect::<Vec<_>>()
                .join(" "),
        );
        assert_eq!(before, after);
    }

    #[test]
    fn inline_matches_the_editor_grammar() {
        let runs = inline_runs(
            "a ==mark== and ~~strike~~ plus **bold** *it* `code` [label](https://x.y) ![alt](img://z) #tag",
            INK,
            BODY,
            REGULAR,
        );
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        // Syntax is chrome — it should never reach the page.
        for syntax in ["==", "~~", "**", "`", "](", "https://x.y", "img://z"] {
            assert!(!text.contains(syntax), "{syntax:?} leaked into {text:?}");
        }
        assert!(text.contains("label") && text.contains("alt") && text.contains("#tag"));

        let find = |needle: &str| runs.iter().find(|r| r.text.contains(needle)).unwrap();
        assert_eq!(find("mark").chip, Chip::Mark);
        assert!(find("strike").strike);
        assert_eq!(find("bold").style.weight, STRONG);
        assert!(find("it").style.italic);
        assert!(find("code").style.mono && find("code").chip == Chip::Code);
        assert!(find("label").underline);
        assert_eq!(find("#tag").chip, Chip::Tag);
    }

    #[test]
    fn headings_and_body_use_the_editor_scale() {
        let lines = layout_lines("# Title\n\nbody\n");
        let sizes: Vec<f32> = lines
            .iter()
            .filter_map(|l| match l {
                Line::Text { runs, .. } => runs.first().map(|r| r.size),
                _ => None,
            })
            .collect();
        assert_eq!(sizes.len(), 2);
        assert!((sizes[0] - BODY * 1.7).abs() < 0.01);
        assert!((sizes[1] - BODY).abs() < 0.01);
    }
}

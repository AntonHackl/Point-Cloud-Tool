use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

use las::Reader;
use serde::Serialize;

#[derive(Clone, Copy)]
enum Kind {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
    F32,
    F64,
}

impl Kind {
    fn from_las(code: u8) -> Option<Self> {
        [
            Self::U8,
            Self::I8,
            Self::U16,
            Self::I16,
            Self::U32,
            Self::I32,
            Self::U64,
            Self::I64,
            Self::F32,
            Self::F64,
        ]
        .get(usize::from(code.checked_sub(1)?))
        .copied()
    }

    fn width(self) -> usize {
        match self {
            Self::U8 | Self::I8 => 1,
            Self::U16 | Self::I16 => 2,
            Self::U32 | Self::I32 | Self::F32 => 4,
            Self::U64 | Self::I64 | Self::F64 => 8,
        }
    }

    fn read(self, bytes: &[u8]) -> Option<Value> {
        macro_rules! read {
            ($t:ty) => {
                <$t>::from_le_bytes(bytes.try_into().expect("scalar width"))
            };
        }
        Some(match self {
            Self::U8 => Value::Unsigned(u64::from(bytes[0])),
            Self::I8 => Value::Signed(i64::from(bytes[0] as i8)),
            Self::U16 => Value::Unsigned(u64::from(read!(u16))),
            Self::I16 => Value::Signed(i64::from(read!(i16))),
            Self::U32 => Value::Unsigned(u64::from(read!(u32))),
            Self::I32 => Value::Signed(i64::from(read!(i32))),
            Self::U64 => Value::Unsigned(read!(u64)),
            Self::I64 => Value::Signed(read!(i64)),
            Self::F32 => Value::float(f64::from(read!(f32)))?,
            Self::F64 => Value::float(read!(f64))?,
        })
    }
}

#[derive(Clone, Copy, Hash, Eq, PartialEq)]
enum Value {
    Unsigned(u64),
    Signed(i64),
    Float(u64),
}

impl Value {
    fn float(value: f64) -> Option<Self> {
        value
            .is_finite()
            .then(|| Self::Float(if value == 0.0 { 0 } else { value.to_bits() }))
    }

    fn number(self) -> f64 {
        match self {
            Self::Unsigned(value) => value as f64,
            Self::Signed(value) => value as f64,
            Self::Float(bits) => f64::from_bits(bits),
        }
    }

    fn distance(self, origin: Self) -> f64 {
        match (self, origin) {
            (Self::Unsigned(value), Self::Unsigned(origin)) => {
                (i128::from(value) - i128::from(origin)) as f64
            }
            (Self::Signed(value), Self::Signed(origin)) => {
                (i128::from(value) - i128::from(origin)) as f64
            }
            _ => self.number() - origin.number(),
        }
    }

    fn label(self) -> String {
        match self {
            Self::Unsigned(value) => value.to_string(),
            Self::Signed(value) => value.to_string(),
            Self::Float(bits) => f64::from_bits(bits).to_string(),
        }
    }

    fn color(self) -> [u8; 3] {
        let bits = match self {
            Self::Unsigned(value) | Self::Float(value) => value,
            Self::Signed(value) => value as u64,
        };
        let mut hash = bits.wrapping_add(0x9e3779b97f4a7c15);
        hash = (hash ^ (hash >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        hash = (hash ^ (hash >> 27)).wrapping_mul(0x94d049bb133111eb);
        hash ^= hash >> 31;
        [0, 8, 16].map(|shift| 70 + ((hash >> shift) & 255) as u8 % 171)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub id: usize,
    pub name: String,
    pub categorical: bool,
}

struct Field {
    info: FieldInfo,
    kind: Kind,
    data: Vec<u8>,
    no_data: Option<Value>,
    scale: f64,
}

impl Field {
    fn new(id: usize, name: &str, kind: Kind) -> Self {
        let lower_name = name.to_ascii_lowercase();
        Self {
            info: FieldInfo {
                id,
                name: name.into(),
                categorical: lower_name.contains("class")
                    || lower_name.contains("instance")
                    || lower_name.ends_with("_id"),
            },
            kind,
            data: Vec::new(),
            no_data: None,
            scale: 1.0,
        }
    }

    fn values(&self) -> impl Iterator<Item = Option<Value>> + '_ {
        self.data.chunks_exact(self.kind.width()).map(|bytes| {
            self.kind
                .read(bytes)
                .filter(|value| Some(*value) != self.no_data)
        })
    }

    fn colors(&self, categorical: bool) -> Vec<u8> {
        const GREY: [u8; 3] = [133, 144, 153];
        let mut colors = Vec::with_capacity(self.data.len() / self.kind.width() * 3);
        if categorical {
            for value in self.values() {
                colors.extend_from_slice(&value.map_or(GREY, Value::color));
            }
            return colors;
        }
        let mut values = self.values().flatten();
        let range = values.next().map(|first| {
            values.fold((first, first), |(min, max), value| {
                (
                    if value.distance(min) < 0.0 {
                        value
                    } else {
                        min
                    },
                    if value.distance(max) > 0.0 {
                        value
                    } else {
                        max
                    },
                )
            })
        });
        for value in self.values() {
            let color = match (value, range) {
                (Some(value), Some((min, max))) => {
                    let span = max.distance(min);
                    let mut t = if span == 0.0 || self.scale == 0.0 {
                        0.5
                    } else if span.is_finite() {
                        value.distance(min) / span
                    } else {
                        (value.number() / 2.0 - min.number() / 2.0)
                            / (max.number() / 2.0 - min.number() / 2.0)
                    };
                    if self.scale < 0.0 {
                        t = 1.0 - t;
                    }
                    gradient(t)
                }
                _ => GREY,
            };
            colors.extend_from_slice(&color);
        }
        colors
    }
}

fn gradient(t: f64) -> [u8; 3] {
    const STOPS: [[u8; 3]; 5] = [
        [57, 34, 109],
        [48, 93, 151],
        [31, 154, 138],
        [123, 198, 88],
        [248, 225, 89],
    ];
    let t = t.clamp(0.0, 1.0) * (STOPS.len() - 1) as f64;
    let index = (t as usize).min(STOPS.len() - 2);
    std::array::from_fn(|channel| {
        let low = f64::from(STOPS[index][channel]);
        let high = f64::from(STOPS[index + 1][channel]);
        (low + (high - low) * (t - index as f64)).round() as u8
    })
}

struct Extra {
    offset: usize,
    field: Field,
}

fn extra_columns(data: &[u8], width: usize, first_id: usize) -> Result<Vec<Extra>, String> {
    if data.len() % 192 != 0 {
        return Err("Malformed LAS Extra Bytes descriptors.".into());
    }
    let mut offset = 0;
    let mut columns = Vec::new();
    for descriptor in data.chunks_exact(192) {
        let code = descriptor[2];
        let options = descriptor[3];
        if code == 0 {
            offset += usize::from(options);
            if offset > width {
                return Err("Extra Bytes descriptors exceed the point record length.".into());
            }
            continue;
        }
        let components = (code - 1) / 10 + 1;
        let kind = Kind::from_las((code - 1) % 10 + 1).expect("LAS scalar code");
        if components > 3 || offset + kind.width() * usize::from(components) > width {
            return Err("Unsupported or malformed LAS Extra Bytes descriptor.".into());
        }
        let name = String::from_utf8_lossy(&descriptor[4..36]);
        let name = name.split('\0').next().unwrap_or_default().trim();
        for component in 0..usize::from(components) {
            if !name.is_empty() {
                let name = if components == 1 {
                    name.to_owned()
                } else {
                    format!("{name}[{component}]")
                };
                let mut field = Field::new(first_id + columns.len(), &name, kind);
                if options & 1 != 0 {
                    let start = 40 + 8 * component;
                    field.no_data = kind.read(&descriptor[start..start + kind.width()]);
                }
                if options & 8 != 0 {
                    let start = 112 + 8 * component;
                    let scale =
                        f64::from_le_bytes(descriptor[start..start + 8].try_into().unwrap());
                    if scale.is_finite() {
                        field.scale = scale;
                    }
                }
                columns.push(Extra { offset, field });
            }
            offset += kind.width();
        }
    }
    Ok(columns)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub id: u64,
    pub name: String,
    pub point_count: usize,
    pub bounds: [[f64; 3]; 2],
    pub origin: [f64; 3],
    pub has_rgb: bool,
    pub fields: Vec<FieldInfo>,
}

struct Instance {
    label: Value,
    point_count: u32,
}

pub struct Groups {
    bytes: axum::body::Bytes,
    instances: Vec<Instance>,
}

pub struct Cloud {
    pub meta: Metadata,
    pub positions: axum::body::Bytes,
    pub rgb: Option<axum::body::Bytes>,
    fields: Vec<Field>,
    groups: Mutex<Option<(usize, Arc<Groups>)>>,
}

impl Cloud {
    pub fn read(path: &Path, id: u64, name: String) -> Result<Self, String> {
        let mut reader =
            Reader::from_path(path).map_err(|error| format!("Could not open LAS/LAZ: {error}"))?;
        let header = reader.header();
        let count = header.number_of_points();
        if count == 0 {
            return Err("This file contains no points.".into());
        }
        if count > u64::from(u32::MAX) {
            return Err("Too many points for the viewer's point IDs.".into());
        }
        let format = *header.point_format();
        let bounds = header.bounds();
        let bounds = [
            [bounds.min.x, bounds.min.y, bounds.min.z],
            [bounds.max.x, bounds.max.y, bounds.max.z],
        ];
        if bounds.iter().flatten().any(|value| !value.is_finite())
            || (0..3).any(|axis| bounds[0][axis] > bounds[1][axis])
        {
            return Err("The file has invalid coordinate bounds.".into());
        }
        let origin = std::array::from_fn(|axis| bounds[0][axis] / 2.0 + bounds[1][axis] / 2.0);

        macro_rules! standard {
            ($(($name:literal, $kind:ident, $read:expr)),* $(,)?) => {
                [$(($name, Kind::$kind, $read as fn(&las::Point, &mut Vec<u8>))),*]
            };
        }
        let mut definitions = standard![
            ("intensity", U16, |p, out| out
                .extend_from_slice(&p.intensity.to_le_bytes())),
            ("classification", U8, |p, out| out
                .push(p.classification.into())),
            ("return_number", U8, |p, out| out.push(p.return_number)),
            ("number_of_returns", U8, |p, out| out
                .push(p.number_of_returns)),
            ("scan_angle", F32, |p, out| out
                .extend_from_slice(&p.scan_angle.to_le_bytes())),
            ("user_data", U8, |p, out| out.push(p.user_data)),
            ("point_source_id", U16, |p, out| out
                .extend_from_slice(&p.point_source_id.to_le_bytes())),
            ("scanner_channel", U8, |p, out| out.push(p.scanner_channel)),
            ("synthetic", U8, |p, out| out.push(u8::from(p.is_synthetic))),
            ("key_point", U8, |p, out| out.push(u8::from(p.is_key_point))),
            ("withheld", U8, |p, out| out.push(u8::from(p.is_withheld))),
            ("overlap", U8, |p, out| out.push(u8::from(p.is_overlap))),
            ("edge_of_flight_line", U8, |p, out| out
                .push(u8::from(p.is_edge_of_flight_line))),
            ("scan_direction", U8, |p, out| out.push(u8::from(matches!(
                p.scan_direction,
                las::point::ScanDirection::RightToLeft
            )))),
        ]
        .to_vec();
        if format.has_gps_time {
            definitions.extend(standard![("gps_time", F64, |p, out| out
                .extend_from_slice(&p.gps_time.unwrap_or(f64::NAN).to_le_bytes()))]);
        }
        if format.has_nir {
            definitions.extend(standard![("nir", U16, |p, out| out
                .extend_from_slice(&p.nir.unwrap_or_default().to_le_bytes()))]);
        }
        let mut fields: Vec<_> = definitions
            .iter()
            .enumerate()
            .map(|(id, (name, kind, _))| Field::new(id, name, *kind))
            .collect();
        let mut extras = match header
            .all_vlrs()
            .find(|record| record.user_id == "LASF_Spec" && record.record_id == 4)
        {
            Some(record) => {
                extra_columns(&record.data, usize::from(format.extra_bytes), fields.len())?
            }
            None => Vec::new(),
        };

        let mut positions = Vec::new();
        let mut rgb = format.has_color.then(Vec::new);
        let mut point_count = 0;
        for point in reader.points() {
            let point =
                point.map_err(|error| format!("Could not decode point {point_count}: {error}"))?;
            for (coordinate, center) in [point.x, point.y, point.z].into_iter().zip(origin) {
                let relative = (coordinate - center) as f32;
                if !relative.is_finite() {
                    return Err("The file contains an invalid coordinate.".into());
                }
                positions.extend_from_slice(&relative.to_le_bytes());
            }
            if let Some(rgb) = &mut rgb {
                let color = point
                    .color
                    .ok_or("A point is missing RGB values declared by its format.")?;
                rgb.extend(
                    [color.red, color.green, color.blue]
                        .map(|value| ((u32::from(value) + 128) / 257) as u8),
                );
            }
            for ((_, _, read), field) in definitions.iter().zip(&mut fields) {
                read(&point, &mut field.data);
            }
            for extra in &mut extras {
                let end = extra.offset + extra.field.kind.width();
                let bytes = point
                    .extra_bytes
                    .get(extra.offset..end)
                    .ok_or("A point is missing declared Extra Bytes.")?;
                extra.field.data.extend_from_slice(bytes);
            }
            point_count += 1;
        }
        if point_count as u64 != count {
            return Err("The file ended before all declared points were read.".into());
        }
        fields.extend(extras.into_iter().map(|extra| extra.field));
        let meta = Metadata {
            id,
            name,
            point_count,
            bounds,
            origin,
            has_rgb: rgb.is_some(),
            fields: fields.iter().map(|field| field.info.clone()).collect(),
        };
        Ok(Self {
            meta,
            positions: positions.into(),
            rgb: rgb.map(Into::into),
            fields,
            groups: Mutex::new(None),
        })
    }

    pub fn colors(&self, field: usize, categorical: bool) -> Option<Vec<u8>> {
        Some(self.fields.get(field)?.colors(categorical))
    }

    pub fn group_indexes(&self, field: usize) -> Option<axum::body::Bytes> {
        Some(self.grouping(field)?.bytes.clone())
    }

    pub fn instance(&self, field: usize, point: usize) -> Option<(u32, Option<String>, u32)> {
        let start = point.checked_mul(4)?;
        let groups = self.grouping(field)?;
        let code = u32::from_le_bytes(
            groups
                .bytes
                .get(start..start.checked_add(4)?)?
                .try_into()
                .ok()?,
        );
        if code == 0 {
            return Some((0, None, 0));
        }
        let instance = groups.instances.get(code as usize - 1)?;
        Some((code, Some(instance.label.label()), instance.point_count))
    }

    fn grouping(&self, field: usize) -> Option<Arc<Groups>> {
        let mut cache = self.groups.lock().expect("groups lock");
        if let Some((id, groups)) = cache.as_ref() {
            if *id == field {
                return Some(groups.clone());
            }
        }
        let field_data = self.fields.get(field)?;
        let mut codes = HashMap::new();
        let mut instances: Vec<Instance> = Vec::new();
        let mut bytes = Vec::with_capacity(self.meta.point_count * 4);
        for value in field_data.values() {
            let code = value.map_or(0, |value| {
                let code = *codes.entry(value).or_insert_with(|| {
                    instances.push(Instance {
                        label: value,
                        point_count: 0,
                    });
                    instances.len() as u32
                });
                instances[code as usize - 1].point_count += 1;
                code
            });
            bytes.extend_from_slice(&code.to_le_bytes());
        }
        let groups = Arc::new(Groups {
            bytes: bytes.into(),
            instances,
        });
        *cache = Some((field, groups.clone()));
        Some(groups)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use las::{Builder, Color, Point, Vlr, Writer, point::Format};

    #[test]
    fn reads_colors_coordinates_and_exact_labels_in_source_order() {
        let directory = tempfile::tempdir().unwrap();
        for extension in ["las", "laz"] {
            let path = directory.path().join(format!("fixture.{extension}"));
            let mut builder = Builder::from((1, 4));
            builder.point_format = Format::new(7).unwrap();
            builder.point_format.extra_bytes = 8;
            let mut descriptor = vec![0; 192];
            descriptor[2] = 8;
            descriptor[3] = 1;
            descriptor[4..15].copy_from_slice(b"instance_id");
            descriptor[40..48].copy_from_slice(&(-1_i64).to_le_bytes());
            builder.vlrs.push(Vlr {
                user_id: "LASF_Spec".into(),
                record_id: 4,
                data: descriptor,
                ..Vlr::default()
            });
            builder.transforms.x.offset = 1_000_000.0;

            let mut writer = Writer::from_path(&path, builder.into_header().unwrap()).unwrap();
            let labels = [
                9_007_199_254_740_992_i64,
                9_007_199_254_740_993,
                9_007_199_254_740_993,
                -1,
            ];
            for (index, label) in labels.into_iter().enumerate() {
                writer
                    .write_point(Point {
                        x: 1_000_000.0 + index as f64,
                        gps_time: Some(1.0),
                        color: Some(Color::new(65535, 32768, 0)),
                        extra_bytes: label.to_le_bytes().to_vec(),
                        ..Point::default()
                    })
                    .unwrap();
            }
            writer.close().unwrap();

            let cloud = Cloud::read(&path, 1, "fixture".into()).unwrap();
            let field = cloud
                .meta
                .fields
                .iter()
                .find(|field| field.name == "instance_id")
                .unwrap()
                .id;
            assert_eq!(cloud.meta.origin, [1_000_001.5, 0.0, 0.0]);
            assert_eq!(cloud.meta.point_count, 4);
            assert_eq!(
                f32::from_le_bytes(cloud.positions[..4].try_into().unwrap()),
                -1.5
            );
            assert_eq!(&cloud.rgb.as_ref().unwrap()[..3], &[255, 128, 0]);
            let bytes = cloud.group_indexes(field).unwrap();
            let groups: Vec<_> = bytes
                .chunks_exact(4)
                .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
                .collect();
            assert_eq!(groups, [1, 2, 2, 0]);
            assert_eq!(
                cloud.instance(field, 1),
                Some((2, Some("9007199254740993".into()), 2))
            );
            assert_eq!(cloud.instance(field, 3), Some((0, None, 0)));
        }
    }

    #[test]
    fn rejects_empty_cloud_and_accepts_points_without_rgb_or_custom_fields() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("plain.las");
        Writer::from_path(&path, las::Header::default())
            .unwrap()
            .close()
            .unwrap();
        assert!(
            matches!(Cloud::read(&path, 1, "empty".into()), Err(error) if error.contains("no points"))
        );

        let mut writer = Writer::from_path(&path, las::Header::default()).unwrap();
        writer.write_point(Point::default()).unwrap();
        writer.close().unwrap();
        let cloud = Cloud::read(&path, 2, "plain".into()).unwrap();
        assert!(!cloud.meta.has_rgb);
        assert_eq!(cloud.meta.point_count, 1);
        assert_eq!(cloud.meta.bounds, [[0.0; 3]; 2]);
        assert_eq!(cloud.meta.fields[0].name, "intensity");
        assert!(
            !cloud
                .meta
                .fields
                .iter()
                .any(|field| field.name == "instance_id")
        );
    }
}

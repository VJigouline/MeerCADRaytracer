// Values of the three.js constants the ray tracer reads. They are copied rather than imported, so
// the library has no runtime dependency on three and its worker bundle stays small. The values
// have been stable across three.js releases.

export const FrontSide = 0;
export const BackSide = 1;
export const DoubleSide = 2;

export const MultiplyOperation = 0;
export const MixOperation = 1;
export const AddOperation = 2;

export const NoToneMapping = 0;
export const LinearToneMapping = 1;
export const ReinhardToneMapping = 2;
export const CineonToneMapping = 3;
export const ACESFilmicToneMapping = 4;
export const CustomToneMapping = 5;
export const AgXToneMapping = 6;
export const NeutralToneMapping = 7;

export const UVMapping = 300;
export const CubeReflectionMapping = 301;
export const CubeRefractionMapping = 302;
export const EquirectangularReflectionMapping = 303;
export const EquirectangularRefractionMapping = 304;
export const CubeUVReflectionMapping = 306;

export const RepeatWrapping = 1000;
export const ClampToEdgeWrapping = 1001;
export const MirroredRepeatWrapping = 1002;

export const UnsignedByteType = 1009;
export const FloatType = 1015;
export const HalfFloatType = 1016;

export const AlphaFormat = 1021;
export const RGBFormat = 1022;
export const RGBAFormat = 1023;
export const RedFormat = 1028;
export const RGFormat = 1030;

export const SRGBColorSpace = 'srgb';
export const LinearSRGBColorSpace = 'srgb-linear';

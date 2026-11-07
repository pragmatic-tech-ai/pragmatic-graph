import { MemberKind, ValueType, type IBindingDescription, type IDefinitionDescription, type ISchemaDescription } from '../index.js';

/**
 * Schema descriptions shared by the GraphEngine tests and their child process (EngineChild.ts).
 * V1: note { text: String?, extra: String? }, item { name: String? }; seed root (note, owner sys).
 * V2: as V1 without note.extra (an upgrade discards it).
 */
export class EngineDescriptions
{
    public static readonly Note = 'note';
    public static readonly Item = 'item';
    public static readonly Text = 'text';
    public static readonly Extra = 'extra';
    public static readonly Name = 'name';
    public static readonly Root = 'root';
    public static readonly Sys = 'sys';
    public static readonly Seeded = 'seeded';
    public static readonly V1Version = 'v1';
    public static readonly V2Version = 'v2';

    public static readonly V1: ISchemaDescription = EngineDescriptions.Desc(EngineDescriptions.V1Version, true, []);
    public static readonly V2: ISchemaDescription = EngineDescriptions.Desc(EngineDescriptions.V2Version, false, []);

    /** V1's definitions and seed under `version`, with `bindings`. */
    public static Desc(version: string, withExtra: boolean, bindings: readonly IBindingDescription[], defaultConnector?: string): ISchemaDescription
    {
        const note: IDefinitionDescription = {
            Name: EngineDescriptions.Note,
            IsAspect: false,
            Parent: null,
            Aspects: [],
            Members: [
                { Name: EngineDescriptions.Text, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
                ...(withExtra ? [{ Name: EngineDescriptions.Extra, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }] : []),
            ],
        };
        const item: IDefinitionDescription = {
            Name: EngineDescriptions.Item,
            IsAspect: false,
            Parent: null,
            Aspects: [],
            Members: [{ Name: EngineDescriptions.Name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }],
        };
        return {
            Version: version,
            Definitions: [note, item],
            Indexes: [],
            Seed: [{ PublicId: EngineDescriptions.Root, Concept: EngineDescriptions.Note, Owner: EngineDescriptions.Sys, Properties: { [EngineDescriptions.Text]: EngineDescriptions.Seeded }, Links: [] }],
            Bindings: bindings,
            ...(defaultConnector === undefined ? {} : { DefaultConnector: defaultConnector }),
        };
    }
}

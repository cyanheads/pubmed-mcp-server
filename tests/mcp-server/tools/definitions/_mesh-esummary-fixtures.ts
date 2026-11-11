/**
 * @fileoverview MeSH eSummary `version=2.0` records captured from NCBI
 * (`esummary.fcgi?db=mesh&version=2.0`, 2026-10-12; `68016449`, a publication
 * type in the `V` tree, and `68016032`, `68018848`, `81000188`, `68004358`,
 * 2026-11-10), keyed by Entrez UID. The bodies of `DS_PaList`, `Children`, and
 * `DS_HeadingMappedToList` are emptied to keep the file small, and so is every
 * `DS_Subheading` but those of `68000900` (Anti-Bacterial Agents), `68016032`
 * (Randomized Controlled Trials as Topic), and `68004358` (Drug Therapy), kept
 * from their 2026-11-10 captures: the other descriptors read as listing no
 * subheadings, whatever upstream lists. Every
 * other field `pubmed_lookup_mesh` reads is verbatim. `99999999` is how
 * version 2.0 answers a UID it holds no record for, inside an otherwise
 * successful set.
 * @module tests/mcp-server/tools/definitions/_mesh-esummary-fixtures
 */

export const MESH_V2_RECORDS: Readonly<Record<string, string>> = {
  '2016754': `<DocumentSummary uid="2016754">
	<DS_YearIntroduced>2017</DS_YearIntroduced>
	<DS_ScopeNote>A clinical syndrome defined by MYOCARDIAL ISCHEMIA symptoms; persistent elevation in the ST segments of the ELECTROCARDIOGRAM; and release of BIOMARKERS of myocardial NECROSIS (e.g., elevated TROPONIN levels). ST segment elevation in the ECG is often used in determining the treatment protocol (see also NON-ST ELEVATION MYOCARDIAL INFARCTION).</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>ST Elevation Myocardial Infarction</string>
		<string>STEMI</string>
		<string>ST Segment Elevation Myocardial Infarction</string>
		<string>ST Elevated Myocardial Infarction</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
		<string>Myocardial Infarction (1999-2016)</string>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C14.280.647.500.875</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C14.907.585.500.875</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C23.550.513.355.750.875</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C23.550.717.489.750.875</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D000072657</DS_MeSHUI>
</DocumentSummary>`,
  '2016755': `<DocumentSummary uid="2016755">
	<DS_YearIntroduced>2017</DS_YearIntroduced>
	<DS_ScopeNote>A myocardial infarction that does not produce elevations in the ST segments of the ELECTROCARDIOGRAM. ST segment elevation of the ECG is often used in determining the treatment protocol (see also ST Elevation Myocardial Infarction).</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Non-ST Elevated Myocardial Infarction</string>
		<string>Non ST Elevated Myocardial Infarction</string>
		<string>NSTEMI</string>
		<string>Non-ST-Elevation Myocardial Infarction</string>
		<string>Infarction, Non-ST-Elevation Myocardial</string>
		<string>Infarctions, Non-ST-Elevation Myocardial</string>
		<string>Myocardial Infarction, Non-ST-Elevation</string>
		<string>Myocardial Infarctions, Non-ST-Elevation</string>
		<string>Non ST Elevation Myocardial Infarction</string>
		<string>Non-ST-Elevation Myocardial Infarctions</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
		<string>Myocardial Infarction (1999-2016)</string>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C14.280.647.500.469</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C14.907.585.500.656</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C23.550.513.355.750.469</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C23.550.717.489.750.469</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D000072658</DS_MeSHUI>
</DocumentSummary>`,
  '2101083': `<DocumentSummary uid="2101083">
	<DS_YearIntroduced>2022</DS_YearIntroduced>
	<DS_ScopeNote>Myocardial infarction in the absence of obstructive coronary artery disease. CORONARY CIRCULATION disruption is due to various other factors such as ATHEROSCLEROTIC PLAQUE and CORONARY VASOSPASM.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>MINOCA</string>
		<string>Myocardial Infarction and Non-obstructed Coronary Arteries</string>
		<string>Myocardial Infarction and Non obstructed Coronary Arteries</string>
		<string>Myocardial Infarction and Nonobstructed Coronary Arteries</string>
		<string>Myocardial Infarction with Non-obstructive Coronary Arteries</string>
		<string>Myocardial Infarction with Non obstructive Coronary Arteries</string>
		<string>Myocardial Infarction with Nonobstructive Coronary Arteries</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
		<string>Myocardial Infarction (2020-2021)</string>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C14.280.647.500.328</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C14.907.585.500.422</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C23.550.513.355.750.328</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68009203</Parent>
			<TreeNum>C23.550.717.489.750.328</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D000088442</DS_MeSHUI>
</DocumentSummary>`,
  '2016178': `<DocumentSummary uid="2016178">
	<DS_YearIntroduced>2017(1967)</DS_YearIntroduced>
	<DS_ScopeNote>Used for the visualization of an anatomical structure or for the diagnosis of disease. Commonly used imaging techniques include radiography, radionuclide imaging, thermography, tomography, and ultrasonography</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>diagnostic imaging</string>
		<string>radiography</string>
		<string>roentgenography</string>
		<string>X-ray</string>
		<string>X-ray diagnosis</string>
		<string>X-ray image</string>
		<string>radionuclide imaging</string>
		<string>radioisotope scanning</string>
		<string>ultrasonography</string>
		<string>echography</string>
		<string>ultrasonic diagnosis</string>
		<string>echotomography</string>
		<string>ultrasound</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>81000175</Parent>
			<TreeNum>Y04.010</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>qualifier</DS_RecordType>
	<DS_MeSHUI>Q000000981</DS_MeSHUI>
</DocumentSummary>`,
  '82000900': `<DocumentSummary uid="82000900">
	<DS_YearIntroduced></DS_YearIntroduced>
	<DS_ScopeNote></DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Anti-Bacterial Agents</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>1000082</Parent>
			<TreeNum>D000900</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>pharmacological-action</DS_RecordType>
	<DS_MeSHUI>D000900</DS_MeSHUI>
</DocumentSummary>`,
  '68000900': `<DocumentSummary uid="68000900">
	<DS_YearIntroduced>2004(1963)</DS_YearIntroduced>
	<DS_ScopeNote>Substances that inhibit the growth or reproduction of BACTERIA.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Anti-Bacterial Agents</string>
		<string>Agents, Anti-Bacterial</string>
		<string>Anti Bacterial Agents</string>
		<string>Anti-Bacterial Compounds</string>
		<string>Anti Bacterial Compounds</string>
		<string>Compounds, Anti-Bacterial</string>
		<string>Antibacterial Agents</string>
		<string>Agents, Antibacterial</string>
		<string>Anti-Bacterial Agent</string>
		<string>Agent, Anti-Bacterial</string>
		<string>Anti Bacterial Agent</string>
		<string>Anti-Bacterial Compound</string>
		<string>Anti Bacterial Compound</string>
		<string>Compound, Anti-Bacterial</string>
		<string>Antibacterial Agent</string>
		<string>Agent, Antibacterial</string>
		<string>Antibiotics</string>
		<string>Antibiotic</string>
		<string>Anti-Mycobacterial Agents</string>
		<string>Agents, Anti-Mycobacterial</string>
		<string>Anti Mycobacterial Agents</string>
		<string>Antimycobacterial Agents</string>
		<string>Agents, Antimycobacterial</string>
		<string>Anti-Mycobacterial Agent</string>
		<string>Agent, Anti-Mycobacterial</string>
		<string>Anti Mycobacterial Agent</string>
		<string>Antimycobacterial Agent</string>
		<string>Agent, Antimycobacterial</string>
		<string>Bacteriocidal Agents</string>
		<string>Agents, Bacteriocidal</string>
		<string>Bacteriocides</string>
		<string>Bacteriocidal Agent</string>
		<string>Agent, Bacteriocidal</string>
		<string>Bacteriocide</string>
	</DS_MeshTerms>
	<DS_Subheading>
		<string>administration and dosage</string>
		<string>adverse effects</string>
		<string>analysis</string>
		<string>biosynthesis</string>
		<string>blood</string>
		<string>cerebrospinal fluid</string>
		<string>chemical synthesis</string>
		<string>chemistry</string>
		<string>classification</string>
		<string>economics</string>
		<string>history</string>
		<string>immunology</string>
		<string>isolation and purification</string>
		<string>metabolism</string>
		<string>pharmacokinetics</string>
		<string>pharmacology</string>
		<string>poisoning</string>
		<string>radiation effects</string>
		<string>standards</string>
		<string>supply and distribution</string>
		<string>therapeutic use</string>
		<string>toxicity</string>
		<string>urine</string>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68000890</Parent>
			<TreeNum>D27.505.954.122.085</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D000900</DS_MeSHUI>
</DocumentSummary>`,
  '82000019': `<DocumentSummary uid="82000019">
	<DS_YearIntroduced></DS_YearIntroduced>
	<DS_ScopeNote></DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Abortifacient Agents</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>1000082</Parent>
			<TreeNum>D000019</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>pharmacological-action</DS_RecordType>
	<DS_MeSHUI>D000019</DS_MeSHUI>
</DocumentSummary>`,
  '68000019': `<DocumentSummary uid="68000019">
	<DS_YearIntroduced>1975</DS_YearIntroduced>
	<DS_ScopeNote>Chemical substances that interrupt pregnancy after implantation.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Abortifacient Agents</string>
		<string>Agents, Abortifacient</string>
		<string>Abortifacients</string>
		<string>Contraceptive Agents, Postconception</string>
		<string>Agents, Postconception Contraceptive</string>
		<string>Postconception Contraceptive Agents</string>
		<string>Abortifacient Effect</string>
		<string>Effect, Abortifacient</string>
		<string>Abortifacient Effects</string>
		<string>Effects, Abortifacient</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
		<string>Abortion, Induced (1970-1974)</string>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
		<int>68010120</int>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68012102</Parent>
			<TreeNum>D27.505.696.875.131</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68012102</Parent>
			<TreeNum>D27.505.954.705.131</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D000019</DS_MeSHUI>
</DocumentSummary>`,
  '68009369': `<DocumentSummary uid="68009369">
	<DS_YearIntroduced>/diagnosis was NEOPLASM DIAGNOSIS 1964-1965</DS_YearIntroduced>
	<DS_ScopeNote>New abnormal growth of tissue. Malignant neoplasms show a greater degree of anaplasia and have the properties of invasion and metastasis, compared to benign neoplasms.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Neoplasms</string>
		<string>Tumors</string>
		<string>Neoplasia</string>
		<string>Neoplasias</string>
		<string>Neoplasm</string>
		<string>Tumor</string>
		<string>Cancer</string>
		<string>Cancers</string>
		<string>Malignant Neoplasm</string>
		<string>Malignancy</string>
		<string>Malignancies</string>
		<string>Malignant Neoplasms</string>
		<string>Neoplasm, Malignant</string>
		<string>Neoplasms, Malignant</string>
		<string>Benign Neoplasms</string>
		<string>Neoplasms, Benign</string>
		<string>Neoplasm, Benign</string>
		<string>Benign Neoplasm</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>1000067</Parent>
			<TreeNum>C04</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D009369</DS_MeSHUI>
</DocumentSummary>`,
  '67000295': `<DocumentSummary uid="67000295">
	<DS_YearIntroduced></DS_YearIntroduced>
	<DS_ScopeNote>photochromic activator of acetylcholine receptors; RN given refers to parent cpd without isomeric designation; structure</DS_ScopeNote>
	<DS_RegistryNumber>81931-05-7</DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Bis-Q</string>
		<string>3,3&apos;-bis(alpha-(trimethylammonium)methyl)azobenzene</string>
		<string>Bis-Q dibromide, (E)-isomer</string>
		<string>Bis-Q dibromide</string>
		<string>trans-3,3&apos;-bis(alpha-(trimethylammonium)methyl)azobenzene dibromide</string>
		<string>Bis-Q, (E)-isomer</string>
		<string>Bis-Q dibromide, (Z)-isomer</string>
		<string>Bis-Q, (Z)-isomer</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
		<string>AZO COMPOUNDS (72-82)</string>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>1000048</Parent>
			<TreeNum>@153</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>supplemental-record</DS_RecordType>
	<DS_MeSHUI>C000295</DS_MeSHUI>
</DocumentSummary>`,
  '81000009': `<DocumentSummary uid="81000009">
	<DS_YearIntroduced>1966</DS_YearIntroduced>
	<DS_ScopeNote>Used with drugs, chemicals, or biological agents in accepted dosage - or with physical agents or manufactured products in normal usage - when intended for diagnostic, therapeutic, prophylactic, or anesthetic purposes. It is used also for adverse effects or complications of diagnostic, therapeutic, prophylactic, anesthetic, surgical, or other procedures.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>adverse effects</string>
		<string>side effects</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>81000494</Parent>
			<TreeNum>Y07.020</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>81000627</Parent>
			<TreeNum>Y10.020</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>qualifier</DS_RecordType>
	<DS_MeSHUI>Q000009</DS_MeSHUI>
</DocumentSummary>`,
  '2025952': `<DocumentSummary uid="2025952">
	<DS_YearIntroduced></DS_YearIntroduced>
	<DS_ScopeNote>anti-CD19 chimeric antigen receptor (CAR) T-cell therapy for treatment of B-Cell lymphoblastic leukemia</DS_ScopeNote>
	<DS_RegistryNumber>Q6C9WHR03O</DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>tisagenlecleucel</string>
		<string>CTL019</string>
		<string>KYMRIAH</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
		<int>2023548</int>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>1000048</Parent>
			<TreeNum>@244302</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>supplemental-record</DS_RecordType>
	<DS_MeSHUI>C000626284</DS_MeSHUI>
</DocumentSummary>`,
  '67585596': `<DocumentSummary uid="67585596">
	<DS_YearIntroduced></DS_YearIntroduced>
	<DS_ScopeNote>fixed combination of linagliptin plus metformin for the treatment of type 2 diabetes</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Jentadueto</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>1000048</Parent>
			<TreeNum>@218176</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>supplemental-record</DS_RecordType>
	<DS_MeSHUI>C585596</DS_MeSHUI>
</DocumentSummary>`,
  '68008687': `<DocumentSummary uid="68008687">
	<DS_YearIntroduced></DS_YearIntroduced>
	<DS_ScopeNote>A biguanide hypoglycemic agent used in the treatment of non-insulin-dependent diabetes mellitus not responding to dietary modification. Metformin improves glycemic control by improving insulin sensitivity and decreasing intestinal absorption of glucose. (From Martindale, The Extra Pharmacopoeia, 30th ed, p289)</DS_ScopeNote>
	<DS_RegistryNumber>9100L32L2N</DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Metformin</string>
		<string>Dimethylbiguanidine</string>
		<string>Dimethylguanylguanidine</string>
		<string>Glucophage</string>
		<string>Metformin Hydrochloride</string>
		<string>Hydrochloride, Metformin</string>
		<string>Metformin HCl</string>
		<string>HCl, Metformin</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
		<int>82007004</int>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68001645</Parent>
			<TreeNum>D02.078.370.141.450</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D008687</DS_MeSHUI>
</DocumentSummary>`,
  '68016449': `<DocumentSummary uid="68016449">
	<DS_YearIntroduced>2008(1991)</DS_YearIntroduced>
	<DS_ScopeNote>A work that reports on a clinical trial that involves at least one test treatment and one control treatment, concurrent enrollment and follow-up of the test- and control-treated groups, and in which the treatments to be administered are selected by a random process, such as the use of a random-numbers table.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Randomized Controlled Trial</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68018848</Parent>
			<TreeNum>V03.175.250.500.500</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D016449</DS_MeSHUI>
</DocumentSummary>`,
  '68016032': `<DocumentSummary uid="68016032">
	<DS_YearIntroduced>2008(1990)</DS_YearIntroduced>
	<DS_ScopeNote>Works about clinical trials that involve at least one test treatment and one control treatment, concurrent enrollment and follow-up of the test- and control-treated groups, and in which the treatments to be administered are selected by a random process, such as the use of a random-numbers table.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Randomized Controlled Trials as Topic</string>
		<string>Clinical Trials, Randomized</string>
		<string>Trials, Randomized Clinical</string>
		<string>Controlled Clinical Trials, Randomized</string>
	</DS_MeshTerms>
	<DS_Subheading>
		<string>classification</string>
		<string>economics</string>
		<string>ethics</string>
		<string>history</string>
		<string>instrumentation</string>
		<string>legislation and jurisprudence</string>
		<string>methods</string>
		<string>psychology</string>
		<string>standards</string>
		<string>statistics and numerical data</string>
		<string>veterinary</string>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
		<string>Clinical Trials (1966-1989)</string>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
		<int>68065228</int>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68018849</Parent>
			<TreeNum>E05.318.372.250.250.365.500</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68018849</Parent>
			<TreeNum>N05.715.360.330.250.250.365.500</TreeNum>
			<Children>
			</Children>
		</LinksType>
		<LinksType>
			<Parent>68018849</Parent>
			<TreeNum>N06.850.520.450.250.250.365.500</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D016032</DS_MeSHUI>
</DocumentSummary>`,
  '68018848': `<DocumentSummary uid="68018848">
	<DS_YearIntroduced>2008(1995)</DS_YearIntroduced>
	<DS_ScopeNote>A work that reports on a clinical trial involving one or more test treatments, at least one control treatment, specified outcome measures for evaluating the studied intervention, and a bias-free method for assigning patients to the test treatment. The treatment may be drugs, devices, or procedures studied for diagnostic, therapeutic, or prophylactic effectiveness. Control measures include placebos, active medicine, no-treatment, dosage forms and regimens, historical comparisons, etc. When randomization using mathematical techniques, such as the use of a random numbers table, is employed to assign patients to test or control treatments, the trial is characterized as a RANDOMIZED CONTROLLED TRIAL.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Controlled Clinical Trial</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68016430</Parent>
			<TreeNum>V03.175.250.500</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D018848</DS_MeSHUI>
</DocumentSummary>`,
  '81000188': `<DocumentSummary uid="81000188">
	<DS_YearIntroduced>1966</DS_YearIntroduced>
	<DS_ScopeNote>Used with disease headings for the treatment of disease by the administration of drugs, chemicals, and antibiotics. For diet therapy and radiotherapy, use specific subheadings. Excludes immunotherapy for which therapy is used.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>drug therapy</string>
		<string>pharmacologic therapy</string>
		<string>pharmacotherapy</string>
		<string>chemotherapy</string>
	</DS_MeshTerms>
	<DS_Subheading>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>81000628</Parent>
			<TreeNum>Y11.020</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>qualifier</DS_RecordType>
	<DS_MeSHUI>Q000188</DS_MeSHUI>
</DocumentSummary>`,
  '68004358': `<DocumentSummary uid="68004358">
	<DS_YearIntroduced></DS_YearIntroduced>
	<DS_ScopeNote>The use of DRUGS to treat a DISEASE or its symptoms. One example is the use of ANTINEOPLASTIC AGENTS to treat CANCER.</DS_ScopeNote>
	<DS_RegistryNumber></DS_RegistryNumber>
	<DS_HeadingMappedTo></DS_HeadingMappedTo>
	<DS_MeshTerms>
		<string>Drug Therapy</string>
		<string>Chemotherapy</string>
		<string>Chemotherapies</string>
		<string>Pharmacotherapy</string>
		<string>Pharmacotherapies</string>
		<string>Therapy, Drug</string>
		<string>Drug Therapies</string>
		<string>Therapies, Drug</string>
	</DS_MeshTerms>
	<DS_Subheading>
		<string>classification</string>
		<string>economics</string>
		<string>ethics</string>
		<string>history</string>
		<string>instrumentation</string>
		<string>methods</string>
		<string>mortality</string>
		<string>nursing</string>
		<string>psychology</string>
		<string>standards</string>
		<string>statistics and numerical data</string>
		<string>trends</string>
		<string>veterinary</string>
	</DS_Subheading>
	<DS_PaPx>
	</DS_PaPx>
	<DS_PreviousIndexing>
	</DS_PreviousIndexing>
	<DS_SeeRelated>
		<int>68008508</int>
		<int>68020228</int>
	</DS_SeeRelated>
	<DS_PaList>
	</DS_PaList>
	<DS_IdxLinks>
		<LinksType>
			<Parent>68013812</Parent>
			<TreeNum>E02.319</TreeNum>
			<Children>
			</Children>
		</LinksType>
	</DS_IdxLinks>
	<DS_EntryDate>1/01/01 00:00</DS_EntryDate>
	<DS_RevisionDate>1/01/01 00:00</DS_RevisionDate>
	<DS_HeadingMappedToList>
	</DS_HeadingMappedToList>
	<DS_RecordType>descriptor</DS_RecordType>
	<DS_MeSHUI>D004358</DS_MeSHUI>
</DocumentSummary>`,
  '99999999': `<DocumentSummary uid="99999999">
<error>cannot get document summary</error>
</DocumentSummary>`,
};

/** A `version=2.0` MeSH eSummary body holding `docs`, in the envelope NCBI sends. */
export function meshSummaryXml(docs: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE eSummaryResult PUBLIC "-//NLM//DTD esummary mesh 20141023//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20141023/esummary_mesh.dtd">
<eSummaryResult>
<DocumentSummarySet status="OK">
<DbBuild>Build261012-0310.1</DbBuild>

${docs.join('\n')}

</DocumentSummarySet>
</eSummaryResult>
`;
}

## Full-Text Articles
**Articles Returned:** 1

### Securing consensus in fractional-order multi-agent systems: Algebraic approaches against Byzantine attacks
**Source:** PMC (structured JATS)

**Authors (7):**
- Yubin Zhong
- Asad Khan
- Muhammad Awais Javeed
- Hassan Raza
- Waqar Ul Hassan
- Azmat Ullah Khan Niazi
- Muhammad Usman Mehmood

**Affiliations:**
- a School of Mathematics and Information Science, Guangzhou University, Guangzhou 510006, PR China
- b Metaverse Research Institute, School of Computer Science and Cyber Engineering, Guangzhou University, Guangzhou 510006, PR China
- c School of Transportation, Southeast University, Nanjing, Jiangsu, 211189, PR China
- d Department of Mathematics, School of Science, Mathematics and Technology, Wenzhou-Kean University, Wenzhou, PR China
- e Department of Mathematics and Statistics, The University of Lahore, Sargodha 40100, Pakistan

**Journal:** Heliyon, **10**(22), e40335, ISSN 2405-8440
**Type:** research-article
**Published:** 2024-11-13
**PMCID:** PMC11609225
**PMID:** 39624286
**DOI:** 10.1016/j.heliyon.2024.e40335
**PMC:** https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11609225/
**PubMed:** https://pubmed.ncbi.nlm.nih.gov/39624286/
**Keywords:** Fractional-order systems, Nonlinear dynamics, Byzantine attacks, Leader-following consensus, Fractional-order Lyapunov approach

#### Abstract
This paper investigates the behavior of fractional-order nonlinear multi-agent systems subjected to Byzantine assaults, specifically focusing on the manipulations of both sensors and actuators. We employ weighted graphs, both directed and undirected, to illustrate the system's topology. Our methodology combines algebraic graph theory with fractional-order Lyapunov techniques to develop algebraic requirements for leader-following consensus, providing a robust framework for analyzing consensus dynamics in these complex systems. We present quantitative results demonstrating the effectiveness of our approach, including two numerical examples that validate the proposed requirements for consensus evaluation. Notably, our work highlights the novelty of using fractional-order systems to enhance resilience against adversarial conditions, contributing significantly to the field of multi-agent systems. By clarifying key terms and streamlining our language, we ensure accessibility for a broader audience while emphasizing the implications of our findings for real-world applications.

#### 1 Introduction
Byzantine attacks pose significant threats as security measures in communication networks primarily focus on external risks. Nodes undergo group authentication (e.g., using WEP or WAP) and are trusted by fellow group members [1]. When a trusted node is compromised and acts maliciously to disrupt network communication, it's termed a Byzantine Attack. Such attacks have severe consequences for the network since other nodes typically rely solely on initial authentication [2]. Byzantine attacks can occur in various scenarios, such as on a college campus where students utilize peer-to-peer communication for file and lecture transfers. Despite passing multiple authentication stages (e.g., college network password, class-specific password, and collaboration group password), a rogue user can initiate a DoS attack by continuously flooding the channel with packets devoid of useful data ([3], [4]). Another example is a hostile battlefield environment, where an enemy captures a physical unit (e.g., a vehicle) and utilizes its wireless communication equipment to launch DoS attacks on other units. The main focus of safe localization research has traditionally been preventing attackers from manipulating reference data or guaranteeing trustworthy localization while under assault [5]. Many approaches have been put out in recent decades to deal with this issue. Using methods that protect reference data integrity and increase the robustness of the observation process is a simple starting point ([6], [7]). The goal of this method, known as the secure localization technique based on robust observations, is to safeguard the real-world qualities of beacon data. Prominent instances of using time, space, or signal coding methods are the SeRLoc algorithm [8] and the distance bounding protocol ([9], [10]). These techniques might not be appropriate for large-scale mass adoption, though, as they frequently call for extra hardware components [11]. In situations where attackers would unavoidably introduce altered observations—also known as malicious observations—researchers have suggested tactics centered around the identification and removal of those harmful observations ([12], [13]). The remaining truthful observations are then used for node localization [14]. The MEF-based localization method is an example of an algorithm that uses this technique, which is sometimes known as the hostile node detection-based secure adaptation technique [15]. Federated learning (FL) has become a revolutionary computer paradigm ([16], [17]) to address these issues. With FL, users may work together to calculate a worldwide machine learning model while keeping their local data secret. To ensure that users' private data stays on their devices, FL distributes the model learning process to end users, such as intelligent devices, aggregating user-specific local models to create a global model. This method improves user privacy while greatly reducing bandwidth costs [18]. Recent research, however, has brought attention to FL's vulnerability to Byzantine assaults, in which malevolent users might tamper with gradients or actual models to impede learning, or contaminate training data to cause false positives in the global model. Blanchard et al. [19] showed that training convergence can be threatened and the global model's performance can be negatively impacted by a single hostile user. Many protection techniques against Byzantine assaults have been put out in an effort to lessen this problem ([20], [21]). Even while these studies have been successful in the short term in preventing Byzantine assaults, it is still difficult to fully defend FL [22]. It is a challenging task to protect FL from Byzantine assaults while attending to issues of efficiency, privacy, and data delivery, especially when its conventional procedures contain unidentified attack surfaces. The security and privacy aspects of federated learning were thoroughly reviewed in a recent survey conducted by Mothukuri et al. [23]. But it didn't test new theories to bolster its conclusions for more study, nor did it carry out tests to concurrently assess pre-existing schemes—an essential step for equitable comparisons. Network intrusion detection systems, or NIDSs, are an essential part of the tool used to protect computer infrastructures from hostile activity ([24], [25]). NIDSs are made expressly to keep an eye on computer networks and use network traffic analysis to find harmful intents. In today's large computer networks, which are made up of several sub-networks, traffic monitoring frequently requires a separated strategy. Placed strategically at different points, sensors and traffic analysis modules are each in charge of keeping an eye on and analyzing the flow of traffic inside a particular sub-network [26]. Normally, NIDS monitoring modules are networked together to facilitate the exchange of security data gathered from various sub-networks. The NIDS organization can be classified as dispersed, hierarchical, or centralized based on how this information is communicated ([27], [28]). Monitoring modules, which may just gather data, send that data up the hierarchy for additional analysis in centralized and hierarchical NIDS designs. Nevertheless, these systems are susceptible to assaults that target the more advanced modules, which might disable the system as a whole. Distributed intrusion detection systems ([29], [30] are used to reduce these risks by preventing single points of failure. Detection and analysis modules in distributed intrusion detection systems frequently serve as all-inclusive sensors [31]. In order to counter assaults from several sources at the same time, including distributed denial of service attacks, they cooperate together to organize coordinated responses throughout the network or improve the detection precision of each NIDS module. Data needed to be delivered to a central location for additional processing in early distributed systems ([32], [33]), which were built on a master-slave architecture. However, modern methods make use of peer-to-peer networks ([34], [35]), which make it possible to identify assaults via completely distributed examination of shared data. Our present effort is significantly related to research investigations that concentrate on the identification of Byzantine nodes. A consensus-based spectrum sensing algorithm for ad hoc wireless networks includes an approach that uses outlier detection techniques to identify compromised nodes ([36], [37]). The attack models that are used to undermine the spectrum sensing technique are further examined in Reference [39]. One such model is a covert adaptive data injection assault, in which findings from sensing are used to dynamically change attack techniques. Isolating neighbor nodes that show notable variances in their numerical data from a predetermined norm is the suggested protection mechanism against such assaults [39]. Reputation-based trust management techniques are used to handle the discovery of Byzantine nodes. In particular, this work addresses attacks in which malicious robots leak incorrect data to nearby nodes in a consensus-based multi-robot system, especially for formation control.

Most existing studies have focused on integer-order systems, which are limited in their ability to account for the long-term memory and hereditary dynamics often present in real-world systems. Integer-order models typically assume that system behavior at any given time depends only on the current state, which may not be sufficient for capturing complex dynamics in adversarial environments, such as those influenced by Byzantine attacks. These attacks introduce uncertainties and disruptions that require systems to not only respond to present conditions but also account for past interactions and accumulated effects. Fractional-order systems, in contrast, offer a more flexible modeling approach due to their inherent ability to capture both present and past dynamics through fractional derivatives. These systems retain memory of previous states, allowing for a more accurate representation of processes that involve long-range dependence or gradual changes over time. This memory effect is particularly beneficial when dealing with Byzantine attacks, as it enables the system to better mitigate the impact of malicious agents by taking into account the history of interactions, thus providing enhanced resilience. By modeling multi-agent systems with fractional-order dynamics, our approach allows for a more robust response to malicious behaviors. The inclusion of memory effects enhances the system's ability to filter out incorrect information injected by compromised agents, ultimately improving both the stability and accuracy of consensus. This novel framework addresses a critical gap in the literature, providing a new direction for improving the resilience of consensus protocols in adversarial settings. Consequently, our contribution significantly advances the state of the art in fractional-order multi-agent systems by offering more sophisticated tools for achieving reliable consensus under Byzantine attacks.

Motivated by our previous discussion, we outlined contributions in a way that:

In this paper, we contribute to the field by studying fractional-order nonlinear systems under Byzantine attacks, including sensor and actuator attacks, within the framework of weighted directed graphs. Notably, our research addresses a significant gap in the literature concerning consensus in fractional-order multi-agent systems under Byzantine attacks. To fill this gap, we propose a novel approach utilizing fractional-order Lyapunov methods. Our contribution includes the selection of a simple quadratic Lyapunov function and the development of algebraic criteria for leader-following consensus using graph theory and linear matrix inequalities. These criteria offer a practical and efficient means of evaluating consensus in such systems. Furthermore, our results extend to fractional-order multi-agent systems with undirected topologies. Finally, we provide two illustrative examples to demonstrate the effectiveness of our proposed methodology.

Our work advances the state of the art by introducing a novel application of fractional-order Lyapunov methods to address consensus under Byzantine attacks, which has been minimally explored. Furthermore, the proposed algebraic criteria offer a more practical and efficient approach for consensus evaluation in both directed and undirected multi-agent systems, filling a critical gap in the current literature.

The structure of the remaining content is as follows:

1. In the 1 section, we introduce the impacts of Byzantine attacks on the controller and explore them from various perspectives.
2. In the section 2 graph theory explained for the communication of agents, some lemmas and definitions provided.
3. In the section 3 provided a problem formation, effects of attack on MAS, some definitions and lemmas provided and theorem proved for the proof of theoretical results.
4. In the section 4 Provided numerical experiments, and two examples provided for the effectiveness of results.
5. In section 5 made conclusions

Notation. Given that R represents the set of real numbers, Rn and Rn1×n2 indicate the n-dimensional real vector space and n1×n2 real matrices, respectively. Here, In stands for the n-dimensional identity matrix, and “T” signifies matrix transposition. The notation λmax(S) denotes the maximum eigenvalue of matrix S, where S is a real matrix. For a vector z∈Rn, its norm is described as |z|=zTz.

#### 2 Preliminaries

##### 2.1 Communication typologies
Let G = (V, E) be a directed weighted graph, which consists of a set of nodes V={v1,v2,...,vN} and a set of directed edges E⊂{(vi,vj):vi,vj∈V}. Each directed edge (vi,vj) denotes an edge starting at node vi and ending at node vj, where vi and vj are referred to as the tail and head, respectively. Ni={vj|(vj,vi)∈E} denotes the set of neighbors of node vi. A weighted adjacency matrix A=(aij)N×N, where aij>0 if (vi,vj)∈E, else aij=0. A directed spanning tree of the digraph G is a sub-graph of G where the directed edges allow the root node to reach every other node.

The Laplacian matrix L=(lij)N×N of graph G is defined as follows:

lij={−aij,i≠j∑k=1k≠iNaik,i=j.

It is evident that ∑j=1Nlij=0 for i=1,2,...,N.

Lemma 2.1 [30] Inequality hold for the matrices L, M, N

(LMMTN)<0.

Which also hold the (N−MTL−1M)<0andL<0 .

Lemma 2.2 [29] Given matrices L∈Rn×n and M∈Rr×r with eigenvalues ζ1,ζ2,…,ζn and ψ1,ψ2,…,ψr respectively, the eigenvalues of their Kronecker product L⊗M can be expressed as ζiψj for i=1,2,…,n and j=1,2,…,r .

Lemma 2.3 [28] Suppose that u[k]∈Rn and zi[k]∈Rn (where zi[k] represents the state of agents) are discrete functions. Then the following relationship holds:

∇Tα(uT[k]u[k])≤2uT[k]∇Tαu[k]∀α∈(0,1),

where ∇Tα is the discrete-time fractional difference operator. We now consider a general discrete fractional nonlinear equation with time delay:

∇Tαzi[k]=f(k,zk)k≥k0,

where 0<α≤1 , zk[ξ]=zi[k+ξ] for ξ∈{−r,…,0} , and f maps R× (bounded sets of N ) into bounded sets of Rn , satisfying f(k,0)=0 .

Definition 2.1 [32] A function f:Rr×R→Rr is said to be QUAD(Δ,η) if there exists a positive constant η and a diagonal matrix Δ∈Rr×r such that:

(m−n)T[f(k,m)−f(k,n)]−(m−n)TΔ(m−n)≤−η(m−n)T(m−n),

for any m,n∈Rr.

Definition 2.2 [38] The discrete-time difference operator of order α for a function f(k) is defined as:

∇Tαf(k)=1Tα∑r=0⌊kT⌋(−1)r(αr)f(k−rT),α>0,

where T is the time step. For convenience, when T = 1, this reduces to:

∇αf(k)=∑r=0k(−1)r(αr)f(k−r).

#### 3 Problem formation
The paper explores the complexity of Byzantine attacks, including weaknesses related to both actuators and sensors, by examining a leader-following consensus framework for fractional-order nonlinear multi-agent systems. The paper provides brief conditions based on fractional-order concepts to strengthen consensus dynamics through a careful investigation. These settings are designed to foster positive agent interaction while strengthening resistance to harmful interference. The research provides useful tactics for enhancing system security and resilience in complex operating situations by examining fractional-order dynamics in combination with several attack vectors.

Consider a MAS consists of n agents, then the dynamics of follower i-th agents can be described as.

(1) ∇Tαzi(k+1)=Mzi(k)+h(k,zi(k))+(ui(k)+gi(k)).

Where zi(k), ui(k), h(k,zi(k)), and gi(k) show the state of follower agent, control input, nonlinear function, and attack signals on the follower agent respectively. M is a constant matrix.

Similarly, the dynamics of leader agents.

(2) ∇Tαz0(k+1)=Mz0(k)+h(k,z0(k))+u0(k).

Where z0(k), u0(k) and h(k,z0(k)) denote the state of the leader agent, control input, and nonlinear function respectively.

##### 3.1 Effect of attacks on MAS
The MAS under the actuator attack can be represented as

(3) uic˜(k)=ui(k)+λiuib(k).

Where ui(k), uic(k) and uib(k) represents the nominal state, corrupted control input and attack signals. The attack occurs only if λi=1; otherwise λ0=0.

The MAS under the sensor attack which can be expressed as

(4) zic(k)=zi(k)+γizib(k).

Where zic(k), zi(k), zib(k) shows the corrupted input, nominal state and attack signal. Similarly attack only when if γi=1 otherwise γi=0.

Now combining the effect of both attacks Eq (3) and Eq (4) we can write such that.

(5) gi(k)=λuib(k)+dk∑miaij[γjzjb(k)−γizib(k)].

Where actuator attack and sensor attack are represented by zib(k) and uib(k), respectively, zjb(k) represents the attack signals with nearby j of agent i. Where dk and aij represent the scaler gain, and (i, j) adjacency matrix A.

Now design a control protocol under the effect of both attacks combining Eq (5).

(6) ui(k)=K∑j=1Naij(zj(k)−zi(k))+Kai0(z0(k))+λiuib(k)+dk∑j=1Naij(γjzjb(k)−γizib(k)).

Where ui(k) is the control input for the i-th follower agent. K is Controller gain. aij is the adjacency matrix element representing connectivity between agents, xj(k) represents the state of the j-th agent at time k, x0(k) also represents the state of the leader agent at time k. λi indicates actuator attack occurrence on the i-th follower agent, uib(k) actuator attack signal, dk is scalar gain for sensor attack compensation, γj also indicates sensor attack occurrence on the j-th follower agent, zjb(k) is sensor attack signal for the j-th follower agent. γi also indicator of sensor attack occurrence on the i-th follower agent and zib(k) is sensor attack signal for the i-th follower agent. Nonlinear with directed connected graph agents under the sensor attack and actuator attack shown in Fig. 1.

[Figure: Figure 1]

Definition 3.1 [27] The follower-leader Eq (1)-(2) consensus converges to zero under the control protocol Eq (6) when i=1,2,3,..., N.

(7) limk→∞⁡‖zi(t)−z0(t)‖=0.

So, the error limk→∞⁡‖σi(k)‖=0.

We make some lemmas and hypothesis:

(H1) for QUAD g(z) is both quadratic in its argument and its derivative is bounded by a quadratic function of the argument, expressed as |g(z)|≤η|z|2 and |g′(z)|≤η|z|, respectively.

(H2). The leader is rooted in a spanning tree contained in the corresponding digraph of the multi-agent system.

Remark 3.1 A positive real component of the eigenvalues of the matrix H⊗K indicates a link between the square of matrix H and the positively of real sections of eigenvalues if the condition (H2) in Lemma 2.2 is met. This need is necessary in order to ensure convergence or stability.

Theorem 3.2 The leader-following consensus of system Eq (1) and Eq (2) under the control law Eq (6) may be reached as long as (H1) and (H2) hold, and there exist a scalar Q>0 and a positive definite matrix S>0 such that,

(8) IN⊗(M+MT+2Δ−2ηIn+βIn+S)+1β(HT⊗KT)(H⊗K)<0

and

(9) IN⊗(βIn−S)+1β(IN⊗NT)(IN⊗N)<0.

Proof We take σi(k)=zi(k)−z0(k), for i=1,2,…,N. As the leader-following consensus requires that σi(k)→0 as k→∞, which aligns with the convergence requirement stated in Eq (7), limk→∞⁡‖zi(t)−z0(t)‖=limk→∞⁡‖σi(k)‖=0. Subtracting Eq (1) from Eq (6) and using Eq (5), we get

(10) ∇Tασ(k)=Mσi(k)+h(k,zi(k))−h(k,z0(k))+K∑j=1Naij(σj(k)−σi(k))+Kai0(σ0(k))+λiuib(k)+dk∑j=1Naij(γjσjb(k)−γiσib(k)).

Choose the Lyapunov function in quadratic form,

υ(k)=∑i=1NσiT(k)σi(k).

Taking the derivative of order α of the Lyapunov function, using Lemma 2.3, and solving Eq (10),

∇Tαυ(k)≤2∑i=1Nσi(k)∇Tασi(k)

(11) =2∑i=1NσiT(k)[Mσi(k)+h(k,zi(k))−h(k,z0(k))+K∑j=1Naij(σj(k)−σi(k))+Kai0(σ0(k))+λiuib(k)+dk∑j=1Naij(γjσjb(k)−γiσib(k))].

By using the Definition 2.1 and satisfying the hypothesis,

(12) σiT(k)[h(k,zi(k))−h(k,z0(k))]≤σiT(k)(Δ−ηIn)σi(k).

By using the Eq (12), we can write the Eq (11)

∇Tασi(k)≤2∑i=1NσiT(k)(M+Δ−ηIn)σi(k)+2dk∑i=1Nσi(IN⊗N)∑j=1Nγjσjbuib(k)+λiuib(k)−2∑i=1NσiT(k)∑j=1Nlijσj(k)−2∑i=1Nai0σiT(k)Kσi(k).

∇Tαυ(k)≤2∑i=1NσiT(k)(M+Δ−ηIn+L)σi(k)−2σT(k)(IN⊗L)σ(k)−2∑i=1Nai0σiT(k)Kσi(k).

To satisfy equation (8), using Lemma 2.3, rewrite in the form,

σT(k)[2(M+MT+2Δ−2ηIn+L)⊗In]σ(k).

Thus, to satisfy equation (8),

2(M+MT+2Δ−2ηIn+L)⊗In+1β(HT⊗KT)(H⊗K)<0.

For equation (9), rewrite involving K as,

−2σT(k)(IN⊗(βIn−S))σ(k).

Therefore, to satisfy equation (9),

IN⊗(βIn−S)+1β(IN⊗NT)(IN⊗N)<0.

From Lemma 2.3 and equations (8) and Eq (9), we conclude that,

(In⊗(M+MT+2Δ+βIn+S)−H⊗K−HT⊗KT−βIn⊗In)<0

and

(IN⊗(βIn−S)In⊗NIN⊗NT−βIN⊗In)<0.

Thus, we conclude that equation that the system asymptotically stable and the consensus of the system is achieved. □

#### 4 Numerical experiments
In the numerical experiments, we provide two examples for the effectiveness and prove above theoretical result.

Example 4.1 We consider that there is leader and four follower MAS which shown in Fig. 2. The error trajectories of MAS shown in Fig. 3. The Fig. 4 shows the influence of sensor and actuator attacks on one leader and four follower multi-agents and the Fig. 5 shows the impact of both attacks on control protocol performance. Let us define the matrices M and N such that

M=(−4.401.20−4.300.90−4.6),andN=(0.3000.20.40000.16).

[Figure: Figure 2]

[Figure: Figure 3]

[Figure: Figure 4]

[Figure: Figure 5]

We define the network communication according to Fig. 2,

A=(0000.71.50000000.6000.100),andA0=(0.3000000000000000.6).

Similarly, we can write the Laplacian matrix L and H, we get it as follows L=H=L+A0 such that,

L=(0.7000.7−1.51.500000.6−0.600−0.101.5),andH=(0.900−0.7−1.5−1.500000.6−0.500−0.101.5).

We define η=0.6, α=0.9, Δ=(0.70000.70000.7), and h(k,zi(k))=16sinzi(k). Given,

• Actuator attack signal uib(k)=0.5.
• Actuator attack indicator λi = 1 (attack occurs).
• Sensor attack signal zib(k)=0.3.
• Sensor attack indicator γi = 1 (attack occurs).
• Scalar gain for sensor attack compensation dk=0.2.
• Adjacency matrix A as provided earlier,

The expression for gi(k) is,

gi(k)=λiuib(k)+dk∑j=1Naij[γjzjb(k)−γizib(k)].

Substituting the given numerical values and the adjacency matrix,

gi(k)=1×0.5+0.2×(0×(0.3−0.3)+1.5×(0.3−0.3)+0×(0.3−0.3)+0.7×(0.3−0.3))=0.5+0=0.5.

Where β=0.6,S=(0.800.0900.600.0900.7) and K=(0.3000.40.50000.2).

Example 4.2 Similarly, we consider a leader and four followers which are shown in Fig. 6 and state error trajectories shown in Fig. 7. The Fig. 8 shows the influence of sensor and actuator attack on one leader and four follower multi-agent system. And Fig. 9 shows the effect of both attacks on control protocol performance.

[Figure: Figure 6]

[Figure: Figure 7]

[Figure: Figure 8]

[Figure: Figure 9]

Similarly we define the matrices M and N such that

M=(−3.900.60−4.6020−3.8),andN=(0.3000.30.4000.2).

A=(01.2001.200.40.800.40000.800),andA0=(0.500000.30000000000).

Similarly, we can derive the laplacian matrices as we calculate in Example 4.1.

L=(1.2−1.200−1.22.2−0.4−0.80−0.40.400−0.800.8),andH=(1.6−1.200−1.22.4−0.4−0.80−0.40.400−0.800.8).

Where we define h(k,zi(k))=12tanhzi(k), Δ=(0.60000.60000.6), η=0.27, S=(0.500.500.600.0500.6) and K=(0.4000.30.60000.5). Remaining values remain same as mentioned in Example 4.1.

##### 4.1 Explanation
The figures in this paper visually represent the dynamics of leader-following multi-agent systems (MAS) under various attack conditions, including sensor, actuator, and Byzantine attacks. Figure 1, Figure 2 illustrate the network communication typologies of nonlinear agents using directed graphs, showcasing the system's vulnerability when subject to sensor, actuator, and Byzantine assaults. Figure 3, Figure 4, Figure 7 plot the state error trajectories of the leader and follower agents, emphasizing how the system converges to consensus or deviates when attacks occur. Figure 5, Figure 8 delve deeper into the impact of these attacks on the control protocol, highlighting the system's robustness under different attack profiles. Annotating key transitions and deviations across these figures offer a clearer understanding of how the control strategies perform, enhancing the visual presentation and ensuring that critical behaviors are evident to the reader. Fig. 6 depicts the network communication topology of nonlinear agents connected through an undirected graph under Byzantine attack, offering insight into how different communication structures influence system resilience. Fig. 9 summarizes the effect of various attacks on the control protocol performance, showing how these adversarial conditions degrade or influence the system's control and stability.

##### 4.2 Camparsion with existing results
In this paper, we propose a novel approach for achieving leader-following consensus in fractional-order multi-agent systems under Byzantine attacks, drawing comparisons with existing consensus methodologies in the literature. For example, the study [40] highlights the importance of integrating multiple renewable energy sources for enhanced reliability. Similarly, our approach leverages fractional-order dynamics to address the complexities introduced by adversarial conditions, demonstrating superior resilience compared to traditional integer-order systems. Additionally, research focused on fractional-order solutions for the nonlinear time-fractional [41] illustrates the application of advanced mathematical techniques in solving complex models. Our use of the fractional-order Lyapunov technique parallels this effort, providing deeper insights into consensus behavior amidst Byzantine attacks. Furthermore, the study of the [42] equation underscores innovative approaches in nonlinear systems, reinforcing the effectiveness of our method in modeling and enhancing system resilience against malicious behavior. By contrasting our work with these references, we underscore how our research advances the state of the art in consensus protocols, showcasing the practicality and robustness of our proposed framework in real-world applications where maintaining consensus is critical despite adversarial challenges.

##### 4.3 Analysis and discussion
In our analysis and discussion, we emphasize the significance of the derived algebraic requirements for leader-following consensus in fractional-order multi-agent systems under Byzantine attacks. The step-by-step breakdown of the fractional-order Lyapunov technique reveals how the inclusion of memory effects enhances system resilience, allowing for more effective filtering of erroneous data from compromised agents. By utilizing both directed and undirected weighted graphs, we illustrate the complex interactions within the system and how these relationships influence consensus dynamics. The numerical examples provided serve to validate our theoretical framework, demonstrating that the proposed criteria not only hold under simulated conditions but also offer practical insights into the behavior of multi-agent systems facing adversarial conditions. This comprehensive discussion underscores the robustness of our approach and its potential applications in developing resilient consensus protocols in real-world scenarios.

#### 5 Conclusion
Recent research has delved into fractional-order nonlinear multi-agent systems with leader-following consensus amidst byzantine attacks combining into sensor and actuator attack, yielding algebraic conditions via fractional-order Lyapunov methods. These conditions, formulated as linear matrix inequalities, offer a straightforward means to assess consensus. The examined multi-agent system aligns with a weighted directed graph, yet the derived conclusions extend to undirected graphs, showcasing the versatility of the proposed methodology across various multi-agent systems. Future endeavors will focus on exploring consensus within fractional-order singular multi-agent systems under Byzantine attacks, indicating a promising avenue for further investigation and advancement in decentralized control strategies.

#### Code availability
The code is considered an intellectual property of the Guangzhou Government project, and therefore not publicly available.

#### Funding
This research was sponsored by the National Natural Science Foundation of China grant No. 12250410247, and also by the Ministry of Science and Technology of China, grant No. WGXZ2023054L.

#### CRediT authorship contribution statement
Yubin Zhong: Validation, Funding acquisition. Asad Khan: Data curation, Conceptualization. Muhammad Awais Javeed: Methodology, Investigation. Hassan Raza: Writing – original draft, Supervision. Waqar Ul Hassan: Resources, Data curation. Azmat Ullah Khan Niazi: Writing – review & editing, Validation, Project administration. Muhammad Usman Mehmood: Resources, Formal analysis.

#### Declaration of Competing Interest
The authors declare that they have no known competing financial interests or personal relationships that could have appeared to influence the work reported in this paper.

Yubin Zhong and Asad Khan reports article publishing charges was provided by Guangzhou University. Yubin Zhong and Asad Khan reports a relationship with Guangzhou University that includes: employment and funding grants. The authors of this manuscript, declare that there are no conflicts of interest regarding the publication of this paper.

#### Assets (9)

> `file` is the pointer exactly as deposited — a name inside the PMC deposit, not a fetchable URL. Open the article at the PMC link above to view it.

##### Figure 1 — Network communication topology of nonlinear with directed connected graph agents under the sensor attack and actuator attack.
*figure · Section: Effect of attacks on MAS · id: fg0010 · file: gr001.jpg*

##### Figure 2 — Network communication topology of nonlinear with directed connected graph agents under the byzantine attack.
*figure · Section: Numerical experiments · id: fg0020 · file: gr002.jpg*

##### Figure 3 — State error trajectories of leader-following MAS.
*figure · Section: Numerical experiments · id: fg0030 · file: gr003.jpg*

##### Figure 4 — Show the influence of sensor and actuator attack on leader and four follower multi agent system.
*figure · Section: Numerical experiments · id: fg0040 · file: gr004.jpg*

##### Figure 5 — Shows the impact of both attacks on control protocol performance.
*figure · Section: Numerical experiments · id: fg0050 · file: gr005.jpg*

##### Figure 6 — Network communication topology of nonlinear of agents connected through an undirected graph under the byzantine attack.
*figure · Section: Numerical experiments · id: fg0060 · file: gr006.jpg*

##### Figure 7 — State error trajectories of leader-following MAS.
*figure · Section: Numerical experiments · id: fg0070 · file: gr007.jpg*

##### Figure 8 — Show the influence of sensor attack and actuator attacks on one leader and four follower agents.
*figure · Section: Numerical experiments · id: fg0080 · file: gr008.jpg*

##### Figure 9 — Shows the effect of attacks on control protocol performance.
*figure · Section: Numerical experiments · id: fg0090 · file: gr009.jpg*

#### References (42)
- [1 br0010] Hong S., Yang H., Yoon Y., Lee J. Group-wise verifiable coded computing under byzantine attacks and stragglers IEEE Trans. Inf. Forensics Secur. 2024
- [2 br0020] Wang Y., Zhai D.H., Xia Y. RFVIR: a robust federated algorithm defending against Byzantine attacks Inf. Fusion 105 2024 102251
- [3 br0030] Wang S., He X., Du J. Scientific commentaries are dealing with uncertainty and complexity in science Inf. Process. Manag. 61(4) 2024 103707
- [4 br0040] Nasir M., Maiti A. Adaptive sliding mode resilient control of multi-robot systems with a leader–follower model under byzantine attacks in the context of the industrial Internet of things Machines 12(3) 2024 205
- [5 br0050] Liu S., Chen T., Wang Z., Chen P.Y., Hong M., Yin W., Zhang Y. Zeroth-order machine learning: fundamental principles and emerging applications in foundation models AAAI Conference on Artificial Intelligence 2024, February
- [6 br0060] H. Schmiedel, R. Han, Q. Tang, R. Steinfeld, J. Yu, Modeling Mobile Crash in Byzantine Consensus, Cryptology ePrint Archive, 2024.
- [7 br0070] Tyloo M. Assessing the impact of Byzantine attacks on coupled phase oscillators J. Phys. Complex. 4(4) 2023 045005
- [8 br0080] Deng H., Pan S. Evaluating Network Boolean Tomography Under Byzantine Attacks GLOBECOM 2023-2023 IEEE Global Communications Conference 2023, December IEEE 7574–7579
- [9 br0090] Wan W., Hu S., Li M., Lu J., Zhang L., Zhang L.Y., Jin H. A four-pronged defense against Byzantine attacks in federated learning Proceedings of the 31st ACM International Conference on Multimedia 2023, October 7394–7402
- [10 br0100] Li B., Wang P., Shao Z., Liu A., Jiang Y., Li Y. Defending Byzantine attacks in ensemble federated learning: a reputation-based phishing approach Future Gener. Comput. Syst. 147 2023 136–148
- [11 br0110] Li S., Ngai E.C.H., Voigt T. An experimental study of byzantine-robust aggregation schemes in federated learning IEEE Trans. Big Data 2023
- [12 br0120] Ge X., Han Q.L., Zhang X.M., Ding D. Communication resource-efficient vehicle platooning control with various spacing policies IEEE/CAA J. Autom. Sin. 11(2) 2023 362–376
- [13 br0130] Su Y., Yang X., Shi P., Wen G., Xu Z. Consensus-based vehicle platoon control under periodic event-triggered strategy IEEE Trans. Syst. Man Cybern. Syst. 2023
- [14 br0140] Alsinai A., Al-Shamiri M.M.A., Hassan W. Ul, Rehman S., Niazi A.U.K. Fuzzy adaptive approaches for robust containment control in nonlinear multi-agent systems under false data injection attacks Fractal Fract. 8(9) 2024 506
- [15 br0150] Silva R., Nguyen A.T., Guerra T.M., Souza F., Frezzatto L. Switched dynamic event-triggered control for string stability of nonhomogeneous vehicle platoons with uncertainty compensation IEEE Trans. Intell. Veh. 2024
- [16 br0160] Li Z., Zhao H., Wang Y., Ren Y., Chen Z., Chen C. Adaptive event-triggered control for almost sure stability for vehicle platooning under interference and stochastic attacks ISA Trans. 138 2023 120–132 PMID 36841719 DOI 10.1016/j.isatra.2023.02.023
- [17 br0170] Pan D., Ding D., Ge X., Han Q.L. Secure event-triggered vehicle platooning control with proportional integral observers under denial of service attacks IFAC-PapersOnLine 56(2) 2023 264–269
- [18 br0180] Long H., Khalatbarisoltani A., Yang Y., Hu X. Hierarchical control strategies for connected heavy-duty modular fuel cell vehicles via decentralized convex optimization IEEE Trans. Veh. Technol. 2023
- [19 br0190] Lu S., Li R., Chen X., Ma Y. Defense against local model poisoning attacks to byzantine-robust federated learning Front. Comput. Sci. 16(6) 2022 166337
- [20 br0200] Kim W., Lim H. FedCC: federated learning with consensus confirmation for Byzantine attack resistance (student abstract) Proc. AAAI Conf. Artif. Intell. 36(11) 2022, June 12981–12982
- [21 br0210] Chen Z., Wu J., Gan J., Chen Z., Zhang J., He J. Robust and efficient cooperative spectrum sensing against probabilistic hard Byzantine attack Trans. Emerg. Telecommun. Technol. 33(4) 2022 e4414
- [22 br0220] Guo S., Zhang T., Yu H., Xie X., Ma L., Xiang T., Liu Y. Byzantine-resilient decentralized stochastic gradient descent IEEE Trans. Circuits Syst. Video Technol. 32(6) 2021 4096–4106
- [23 br0230] Xu J., Huang S.L., Song L., Lan T. Byzantine-robust federated learning through collaborative malicious gradient filtering 2022 IEEE 42nd International Conference on Distributed Computing Systems (ICDCS) 2022, July IEEE 1223–1235
- [24 br0240] Gan J., Wu J. Exploitation analysis of byzantine attack for cooperative spectrum sensing 2021 IEEE 94th Vehicular Technology Conference (VTC2021-Fall) 2021, September IEEE 1–7
- [25 br0250] Xia Q., Tao Z., Li Q. Defending against byzantine attacks in quantum federated learning 2021 17th International Conference on Mobility, Sensing and Networking (MSN) 2021, December IEEE 145–152
- [26 br0260] Shi J., Wan W., Hu S., Lu J., Zhang L.Y. Challenges and approaches for mitigating byzantine attacks in federated learning 2022 IEEE International Conference on Trust, Security and Privacy in Computing and Communications (TrustCom) 2022, December IEEE 139–146
- [27 br0270] Varma K., Zhou Y., Baracaldo N., Anwar A. Legato: a layerwise gradient aggregation algorithm for mitigating byzantine attacks in federated learning 2021 IEEE 14th International Conference on Cloud Computing (CLOUD) 2021, September IEEE 272–277
- [28 br0280] Liu X., Lim T.J., Huang J. Optimal byzantine attacker identification based on game theory in network coding enabled wireless ad hoc networks IEEE Trans. Inf. Forensics Secur. 15 2020 2570–2583
- [29 br0290] Yang Y., Xiong P., Wang Q., Zhang Q. Analysis of Byzantine attacks for target tracking in wireless sensor networks Sensors 19(15) 2019 3436 PMID 31387325 DOI 10.3390/s19153436 PMCID PMC6695678
- [30 br0300] Wu J., Li P., Chen Y., Tang J., Wei C., Xia L., Song T. Analysis of Byzantine attack strategy for cooperative spectrum sensing IEEE Commun. Lett. 24(8) 2020 1631–1635
- [31 br0310] Wu J., Song T., Yu Y., Wang C., Hu J. Sequential cooperative spectrum sensing in the presence of dynamic Byzantine attack for mobile networks PLoS ONE 13(7) 2018 e0199546 DOI 10.1371/journal.pone.0199546 PMCID PMC6033420 PMID 29975727
- [32 br0320] Wu J., Song T., Yu Y., Wang C., Hu J. Generalized byzantine attack and defense in cooperative spectrum sensing for cognitive radio networks IEEE Access 6 2018 53272–53286
- [33 br0330] Hashlamoun W., Brahma S., Varshney P.K. Mitigation of Byzantine attacks on distributed detection systems using audit bits IEEE Trans. Signal Inf. Process. Netw. 4(1) 2017 18–32
- [34 br0340] Sharma M. Combating resource consumption and byzantine attacks in manet through enhanced cbds technique 2017
- [35 br0350] Mohan P.M., Truong-Huu T., Gurusamy M. Primary-backup controller mapping for Byzantine fault tolerance in software defined networks GLOBECOM 2017-2017 IEEE Global Communications Conference 2017, December IEEE 1–7
- [36 br0360] Cao R., Wong T.F., Lv T., Gao H., Yang S. Detecting Byzantine attacks without clean reference IEEE Trans. Inf. Forensics Secur. 11(12) 2016 2717–2731
- [37 br0370] Louati H., Niazi A.U.K., Dalam M.E., Hassan W.U., Khan K.H., Alhagyan M. Optimizing control efficiency in discrete-time multi-agent systems via event-triggered containment techniques combining disturbance handling and input delay management Heliyon 10(14) 2024 DOI 10.1016/j.heliyon.2024.e33975 PMCID PMC11301208 PMID 39108846
- [38 br0380] Yang R., Liu S., Tan Y.Y., Zhang Y.J., Jiang W. Consensus analysis of fractional-order nonlinear multi-agent systems with distributed and input delays Neurocomputing 329 2019 46–52
- [39 br0390] Du J., Wen X., Shang L., Zou S., Zhang B., Guo D., Song Y. A byzantine attack defender for censoring-enabled cognitive radio networks 2015 International Conference on Wireless Communications & Signal Processing (WCSP) 2015, October IEEE 1–6
- [40 br0400] Al-Sawalha M.M., Yasmin H., Muhammad S., Khan Y., Shah R. Optimal power management of a stand-alone hybrid energy management system: hydro-photovoltaic-fuel cell Ain Shams Eng. J. 103089 2024
- [41 br0410] Alshehry A.S., Yasmin H., Shah R., Ali A., Khan I. Fractional-order view analysis of Fisher's and foam drainage equations within Aboodh transform Eng. Comput. 41(3) 2024 489–515
- [42 br0420] Yasmin H., Alshehry A.S., Ganie A.H., Mahnashi A.M., Shah R. Perturbed Gerdjikov–Ivanov equation: soliton solutions via Backlund transformation Optik 298 2024 171576
